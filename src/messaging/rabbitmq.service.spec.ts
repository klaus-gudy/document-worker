import { Logger } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';

import { redactUrl } from '@/common/logging/log-format';
import { RabbitmqService } from '@/messaging/rabbitmq.service';

type Listener = (...args: never[]) => void;

const connect = jest.fn<Promise<unknown>, [string]>();

jest.mock('amqplib', () => ({
  connect: (url: string) => connect(url),
}));

/** The 'close' (or 'error') listener amqplib was handed for that emitter. */
const listenerFor = (
  on: jest.Mock<void, [string, Listener]>,
  event: string,
): Listener => {
  const call = on.mock.calls.find(([name]) => name === event);
  if (!call) throw new Error(`no "${event}" listener was registered`);
  return call[1];
};

/**
 * Covers the two failures this service was changed for: the broker password
 * reaching the log, and a broker that is down at boot taking the process with
 * it. Both are transport concerns, so the broker itself is a double — the
 * behaviour under test is what this class does with a connection, not what
 * RabbitMQ does with a frame.
 */
describe('RabbitmqService', () => {
  const config = {
    url: 'amqp://worker:hunter2@broker.internal:5672',
    exchange: 'jarvis.events',
    queue: 'DOCUMENT_WORKER_QUEUE',
    routingKey: 'lease.created',
    completionRoutingKey: 'document.stored',
    deadLetterExchange: 'jarvis.events.dlx',
    deadLetterQueue: 'DOCUMENT_WORKER_QUEUE_DEAD',
    prefetch: 1,
  };

  let logged: string[];
  let service: RabbitmqService;

  /** A channel double that records the consumer it is handed. */
  const makeChannel = () => ({
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    prefetch: jest.fn().mockResolvedValue(undefined),
    consume: jest
      .fn<
        Promise<{ consumerTag: string }>,
        [string, (m: ConsumeMessage) => void]
      >()
      .mockResolvedValue({ consumerTag: 'tag' }),
    checkExchange: jest.fn().mockResolvedValue(undefined),
    ack: jest.fn(),
    nack: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn<void, [string, Listener]>(),
  });

  const makeConnection = (channel: ReturnType<typeof makeChannel>) => ({
    createChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn<void, [string, Listener]>(),
  });

  beforeEach(() => {
    jest.useFakeTimers();
    logged = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => logged.push(String(message)));
    }
    connect.mockReset();
    service = new RabbitmqService(config);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('never prints the broker password', async () => {
    const channel = makeChannel();
    connect.mockResolvedValue(makeConnection(channel));

    await service.onModuleInit();

    expect(logged.some((line) => line.includes('hunter2'))).toBe(false);
    expect(logged).toContainEqual(
      expect.stringContaining('amqp://worker:***@broker.internal:5672'),
    );
  });

  it('keeps the password out of a failed connection log too', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await service.onModuleInit();

    expect(logged.some((line) => line.includes('hunter2'))).toBe(false);
    expect(logged).toContainEqual(expect.stringContaining('ECONNREFUSED'));
  });

  it('boots without a broker instead of throwing, then retries', async () => {
    const channel = makeChannel();
    connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeConnection(channel));

    // The crash this replaces: onModuleInit rejected, nothing caught it, and
    // the process exited.
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(await service.checkHealth()).toEqual({
      status: 'down',
      error: 'not connected',
    });

    await jest.advanceTimersByTimeAsync(1_000);

    expect(connect).toHaveBeenCalledTimes(2);
    expect((await service.checkHealth()).status).toBe('up');
  });

  it('backs off between attempts and stops at the ceiling', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await service.onModuleInit();
    // 1s, 2s, 4s, 8s, 16s, then capped at 30s — a broker down for an hour is
    // dialled a couple of hundred times, not tens of thousands.
    await jest.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000);
    expect(connect).toHaveBeenCalledTimes(6);

    await jest.advanceTimersByTimeAsync(29_000);
    expect(connect).toHaveBeenCalledTimes(6);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(7);
  });

  it('replays subscriptions registered while the broker was down', async () => {
    const channel = makeChannel();
    connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(makeConnection(channel));

    await service.onModuleInit();
    await service.subscribe(
      { queue: config.queue, routingKeys: [config.routingKey] },
      () => undefined,
    );

    // Registered, not consuming: there is no channel to consume on yet.
    expect(channel.consume).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);

    expect(channel.assertQueue).toHaveBeenCalledWith(
      config.queue,
      expect.objectContaining({
        deadLetterExchange: config.deadLetterExchange,
        deadLetterRoutingKey: config.queue,
      }),
    );
    expect(channel.bindQueue).toHaveBeenCalledWith(
      config.queue,
      config.exchange,
      config.routingKey,
    );
    expect(channel.consume).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes on the new channel after a reconnect', async () => {
    const first = makeChannel();
    const second = makeChannel();
    const firstConnection = makeConnection(first);
    connect
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(makeConnection(second));

    await service.onModuleInit();
    await service.subscribe(
      { queue: config.queue, routingKeys: [config.routingKey] },
      () => undefined,
    );
    expect(first.consume).toHaveBeenCalledTimes(1);

    // The broker going away: amqplib emits 'close' on the connection.
    listenerFor(firstConnection.on, 'close')();

    expect((await service.checkHealth()).status).toBe('down');

    await jest.advanceTimersByTimeAsync(1_000);

    // Without the replay the process would look healthy and consume nothing.
    expect(second.consume).toHaveBeenCalledTimes(1);
    expect((await service.checkHealth()).status).toBe('up');
  });

  it('does not ack a message whose channel died, since it is already requeued', async () => {
    const first = makeChannel();
    const firstConnection = makeConnection(first);
    connect
      .mockResolvedValueOnce(firstConnection)
      .mockResolvedValueOnce(makeConnection(makeChannel()));

    await service.onModuleInit();
    await service.subscribe(
      { queue: config.queue, routingKeys: [config.routingKey] },
      () => undefined,
    );

    // Deliver a message, then lose the connection before it is settled.
    const deliver = first.consume.mock.calls[0][1];
    const message = {
      fields: {
        deliveryTag: 7,
        redelivered: false,
        routingKey: 'lease.created',
      },
      content: Buffer.from('{}'),
    } as unknown as ConsumeMessage;
    deliver(message);

    listenerFor(firstConnection.on, 'close')();
    await jest.advanceTimersByTimeAsync(1_000);

    service.ack(message);

    // Acking here is a protocol error that would close the *new* channel.
    expect(first.ack).not.toHaveBeenCalled();
    expect(logged).toContainEqual(expect.stringContaining('cannot ack'));
  });

  it('stops reconnecting once shut down', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await service.onModuleInit();
    await service.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(connect).toHaveBeenCalledTimes(1);
  });
});

describe('redactUrl', () => {
  it('masks the password and keeps everything else readable', () => {
    expect(redactUrl('amqp://worker:hunter2@broker.internal:5672')).toContain(
      'amqp://worker:***@broker.internal:5672',
    );
  });

  it('leaves a URL with no credentials alone', () => {
    expect(redactUrl('amqp://broker.internal:5672')).toBe(
      'amqp://broker.internal:5672',
    );
  });

  it('still masks something that does not parse as a URL', () => {
    expect(redactUrl('not a url://worker:hunter2@host')).not.toContain(
      'hunter2',
    );
  });
});
