export default () => ({
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
  github: {
    appId: process.env.GITHUB_APP_ID,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    privateKey: process.env.GITHUB_PRIVATE_KEY,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  google: {
    apiKey: process.env.GOOGLE_API_KEY,
  },
});
