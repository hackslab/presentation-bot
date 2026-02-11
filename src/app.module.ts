import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { TelegramBotModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isTest = configService.get('NODE_ENV') === 'test';
        const token = configService.get<string>('TELEGRAM_BOT_TOKEN');

        if (!token && !isTest) {
          throw new Error('TELEGRAM_BOT_TOKEN is required');
        }

        return {
          token: token ?? '000000:TEST_TOKEN',
          launchOptions: isTest ? false : { dropPendingUpdates: true },
        };
      },
    }),
    TelegramBotModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
