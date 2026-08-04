import express from 'express';
import { db } from './db.js';
import { env, hasLlm } from './env.js';
import { authRoutes } from './routes/auth.js';
import { petRoutes } from './routes/pet.js';
import { roomRoutes } from './routes/room.js';
import { socialRoutes } from './routes/social.js';

const app = express();
const database = db();

app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, llm: hasLlm(), model: hasLlm() ? env.azure.deployment : null });
});

app.use('/api/auth', authRoutes(database));
app.use('/api/pet', petRoutes(database));
app.use('/api/social', socialRoutes(database));
app.use('/api/room', roomRoutes(database));

// 想定外の例外でプロセスを落とさない（育成中のデータを守る）。
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[ai-pet] unhandled', error);
  if (!res.headersSent) {
    res.status(500).json({ error: 'サーバでエラーが起きました' });
  }
});

app.listen(env.port, () => {
  console.log(`[ai-pet] server on http://127.0.0.1:${env.port}`);
  console.log(`[ai-pet] db: ${env.dbPath}`);
  console.log(
    hasLlm()
      ? `[ai-pet] llm: ${env.azure.deployment} @ ${env.azure.endpoint}`
      : '[ai-pet] llm: 未設定（定型リアクションで動作します）',
  );
});
