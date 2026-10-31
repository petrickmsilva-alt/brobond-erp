// Aplica bootstrap + cadeia versionada num banco apontado por DATABASE_URL.
// Usado pelos scripts de recuperação (fonte e alvo) para não duplicar o boot.
import { migrate } from './db';
await migrate();
