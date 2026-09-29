import { Global, Module } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/config';
import { SecretBox } from './secret-box';

export const SECRET_BOX = Symbol('SECRET_BOX');

@Global()
@Module({
  providers: [
    {
      provide: SECRET_BOX,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => new SecretBox(config.DEPLOYFORGE_MASTER_KEYS, config.DEPLOYFORGE_ACTIVE_KEY_ID),
    },
  ],
  exports: [SECRET_BOX],
})
export class CryptoModule {}
