declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    MEDIA: R2Bucket;
    WORKER_TOKEN?: string;
    SCHEDULER_TOKEN?: string;
    WEBHOOK_SECRET?: string;
    RENDER_CONCURRENCY_LIMIT?: string;
    MONTHLY_RENDER_BUDGET_MICROS?: string;
    BOOTSTRAP_ADMIN_EMAILS?: string;
    MEDIA_SIGNING_SECRET?: string;
  }
}
