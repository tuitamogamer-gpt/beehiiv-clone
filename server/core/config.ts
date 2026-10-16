import { randomBytes } from 'node:crypto';
const devSecret = randomBytes(32).toString('hex');
export const config = {
  production: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
  appUrl: (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  sqlitePath: process.env.SQLITE_PATH || '.data/newsletter.sqlite',
  sessionSecret: process.env.SESSION_SECRET || ((process.env.NODE_ENV !== 'production' && process.env.VERCEL !== '1') ? devSecret : undefined),
  cronSecret: process.env.CRON_SECRET,
  resendApiKey: process.env.RESEND_API_KEY,
  resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  emailFrom: process.env.EMAIL_FROM,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  turnstileSecretKey: process.env.TURNSTILE_SECRET_KEY,
  turnstileSiteKey: process.env.TURNSTILE_SITE_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  blobToken: process.env.BLOB_READ_WRITE_TOKEN,
  bootstrapToken: process.env.BOOTSTRAP_TOKEN,
};
export function configurationStatus() {
 const database=Boolean(config.databaseUrl) || !config.production;
 return { mode:config.production?'production':'development', database:config.databaseUrl?'postgres':config.production?'not_configured':'sqlite', authentication:database&&Boolean(config.sessionSecret&&config.sessionSecret.length>=32), email:Boolean(config.resendApiKey&&config.resendWebhookSecret&&config.emailFrom), payments:Boolean(config.stripeSecretKey&&config.stripeWebhookSecret), botProtection:Boolean(config.turnstileSecretKey&&config.turnstileSiteKey), ai:Boolean(config.openaiApiKey), media:Boolean(config.blobToken), scheduler:Boolean(config.cronSecret&&process.env.SCHEDULER_ENABLED==='true'), schedulerSecretConfigured:Boolean(config.cronSecret), publicUrlConfigured:Boolean(process.env.APP_URL), turnstileSiteKey:config.turnstileSiteKey||null };
}
