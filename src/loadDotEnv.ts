/**
 * Loads `.env` from the working directory, if there is one, so `npm run serve`
 * and the scripts pick up HERE_API_KEY / DATABASE_PATH without exporting them
 * by hand. Variables already set in the real environment always win.
 */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
