import { execFileSync } from 'node:child_process';

// The CLI and CI use the same sequence. Stop immediately if any dependency
// fails, before deploying the main Worker that consumes its RPC interface.
execFileSync('bun', ['run', 'build'], { stdio: 'inherit' });

for (const worker of ['biome', 'esbuild', 'vite_host', 'push', 'email']) {
	execFileSync('bunx', ['wrangler', 'deploy', '-c', `dist/${worker}_worker/wrangler.json`], { stdio: 'inherit' });
}

execFileSync('bun', ['run', 'db:migrate:remote'], { stdio: 'inherit' });
execFileSync('bunx', ['wrangler', 'deploy', '--no-bundle'], { stdio: 'inherit' });
