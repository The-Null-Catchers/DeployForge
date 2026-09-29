import { Global, Module } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config/config';
import { FixtureGithubClient, RealGithubClient, type GithubClient } from './github.client';

export const GITHUB_CLIENT = Symbol('GITHUB_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: GITHUB_CLIENT,
      inject: [CONFIG],
      useFactory: (config: AppConfig): GithubClient | null => {
        if (config.GITHUB_MODE === 'real') return new RealGithubClient(config);
        if (config.GITHUB_MODE === 'fixture') {
          return new FixtureGithubClient(process.env.GITHUB_FIXTURE_FILE ?? { installations: [] });
        }
        return null;
      },
    },
  ],
  exports: [GITHUB_CLIENT],
})
export class GithubClientModule {}
