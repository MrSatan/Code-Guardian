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
  ai: {
    maxDiffLinesForChunking: parseInt(process.env.AI_MAX_DIFF_LINES || '300', 10),
    maxDiffSizeForChunking: parseInt(process.env.AI_MAX_DIFF_SIZE || '20000', 10),
    maxFileChunkLines: parseInt(process.env.AI_MAX_FILE_CHUNK_LINES || '150', 10),
    maxFileChunkSize: parseInt(process.env.AI_MAX_FILE_CHUNK_SIZE || '8000', 10),
    maxSubChunkLines: parseInt(process.env.AI_MAX_SUB_CHUNK_LINES || '80', 10),
    maxOutputTokens: parseInt(process.env.AI_MAX_OUTPUT_TOKENS || '1500', 10),
    parallelBatchSize: parseInt(process.env.AI_PARALLEL_BATCH_SIZE || '3', 10),
    excludedFilePatterns: (process.env.AI_EXCLUDED_FILES || 'package-lock.json,yarn.lock,pnpm-lock.yaml,dist/,build/,node_modules/,.git/,.DS_Store,Thumbs.db,.vscode/,.idea/').split(','),
    chunkMergeEnabled: process.env.AI_CHUNK_MERGE_ENABLED !== 'false', // Default true
    optimalChunkSize: parseInt(process.env.AI_OPTIMAL_CHUNK_SIZE || '120', 10),
    maxChunkSize: parseInt(process.env.AI_MAX_CHUNK_SIZE || '200', 10),
    minChunkSize: parseInt(process.env.AI_MIN_CHUNK_SIZE || '40', 10),
    // Rate limiting for 10K tokens/minute
    rateLimitEnabled: process.env.AI_RATE_LIMIT_ENABLED === 'true', // Default false
    rateLimitTokensPerMinute: parseInt(process.env.AI_RATE_LIMIT_TPM || '8000', 10), // 80% of 10K limit
    rateLimitRequestsPerMinute: parseInt(process.env.AI_RATE_LIMIT_RPM || '30', 10),  // Conservative request limit
  },
});
