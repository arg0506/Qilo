import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { APP_CONFIG, type AppConfig } from "./config/config.ts";
import { DbModule } from "./db/db.module.ts";
import { RedisModule } from "./redis/redis.module.ts";
import { ErrorFilter } from "./common/http.ts";
import { RateLimitService } from "./common/rate-limit.service.ts";
import { AuditService } from "./audit/audit.service.ts";
import { AnalyticsService } from "./analytics/analytics.service.ts";
import { AuthGuard } from "./auth/auth.guard.ts";
import { TokenVerifier } from "./auth/token-verifier.ts";
import { AuthController } from "./auth/auth.controller.ts";
import { UsersService } from "./users/users.service.ts";
import { AccountService } from "./users/account.service.ts";
import { MeController } from "./users/me.controller.ts";
import { MediaStorage, createStorage } from "./media/storage.ts";
import { MediaService } from "./media/media.service.ts";
import { MediaController } from "./media/media.controller.ts";
import { QuizzesService } from "./quizzes/quizzes.service.ts";
import { QuizzesController } from "./quizzes/quizzes.controller.ts";
import { RoomsService } from "./rooms/rooms.service.ts";
import { RoomsController } from "./rooms/rooms.controller.ts";
import { SnapshotService } from "./rooms/snapshot.service.ts";
import { MatchesService } from "./matches/matches.service.ts";
import { MatchesController } from "./matches/matches.controller.ts";
import { ReportsService } from "./reports/reports.service.ts";
import { ReportsController } from "./reports/reports.controller.ts";
import { Broadcaster } from "./realtime/broadcaster.service.ts";
import { TimersService } from "./realtime/timers.service.ts";
import { PresenceService } from "./realtime/presence.service.ts";
import { GameService } from "./realtime/game.service.ts";
import { GameGateway } from "./realtime/game.gateway.ts";
import { MaintenanceService } from "./maintenance/maintenance.service.ts";
import { HealthController } from "./health/health.controller.ts";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        { module: class ConfigModule {}, global: true, providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] },
        DbModule,
        RedisModule,
      ],
      controllers: [
        HealthController,
        AuthController,
        MeController,
        QuizzesController,
        MediaController,
        RoomsController,
        MatchesController,
        ReportsController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: MediaStorage, useFactory: () => createStorage(config) },
        RateLimitService,
        AuditService,
        AnalyticsService,
        TokenVerifier,
        UsersService,
        AccountService,
        MediaService,
        QuizzesService,
        SnapshotService,
        RoomsService,
        MatchesService,
        ReportsService,
        Broadcaster,
        TimersService,
        PresenceService,
        GameService,
        GameGateway,
        MaintenanceService,
      ],
    };
  }
}
