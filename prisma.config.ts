import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'vendor/umami/prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
