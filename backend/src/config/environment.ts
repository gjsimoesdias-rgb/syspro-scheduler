import dotenv from 'dotenv';

dotenv.config();

export interface EnvironmentConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  schedulingHorizonDays: number;
  schedulingInterval: number; // ms
  maxOvertimePerDay: number; // hours
  batchMinimumSize: number;
  defaultSetupTimeMinutes: number;
  defaultQueueTimeMinutes: number;
  defaultMovementTimeMinutes: number;
  useApsViews: boolean; // Read from APS views instead of Syspro tables directly
  // Active Directory / Windows-integrated auth
  adDomain: string | undefined;
  adDcUrl: string | undefined;
  // CP-SAT sidecar
  cpSatUrl: string | undefined;
}

const environment: EnvironmentConfig = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  schedulingHorizonDays: parseInt(process.env.HORIZON_DAYS || '28', 10),
  schedulingInterval: parseInt(process.env.SCHEDULE_INTERVAL || '3600000', 10), // 1 hour default
  maxOvertimePerDay: parseFloat(process.env.MAX_OVERTIME_HOURS || '3.0'),
  batchMinimumSize: parseInt(process.env.BATCH_MIN_SIZE || '1', 10),
  defaultSetupTimeMinutes: parseInt(process.env.SETUP_TIME_MIN || '30', 10),
  defaultQueueTimeMinutes: parseInt(process.env.QUEUE_TIME_MIN || '15', 10),
  defaultMovementTimeMinutes: parseInt(process.env.MOVEMENT_TIME_MIN || '10', 10),
  useApsViews: (process.env.USE_APS_VIEWS || 'false').toLowerCase() === 'true',
  adDomain: process.env.AD_DOMAIN || undefined,
  adDcUrl: process.env.AD_DC_URL || undefined,
  cpSatUrl: process.env.CP_SAT_URL || undefined,
};

export default environment;
