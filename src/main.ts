import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const logger = new Logger("Bootstrap");

  process.on("unhandledRejection", (reason) => {
    logger.error(
      "Unhandled promise rejection aniqlandi.",
      reason instanceof Error ? reason.stack : String(reason),
    );
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception aniqlandi.", error.stack);
  });

  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
