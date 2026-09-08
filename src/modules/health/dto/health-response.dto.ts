import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ example: 'ok', enum: ['ok'] })
  status: 'ok';

  @ApiProperty({
    example: 42,
    description: 'Seconds since this process started.',
  })
  uptimeSeconds: number;
}
