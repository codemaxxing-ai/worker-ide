// ── Flow diagram data model ──────────────────────────────

export interface GraphNode {
	id: string;
	name: string;
	detail: string;
	color: string;
}

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	label: string;
	color: string;
}

export interface FlowSection {
	label?: string;
	labelColor?: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
}

interface DocsTopic {
	slug: string;
	title: string;
	description: string;
	tagline: string;
	accent: string;
	laneDescription: string;
	sections: FlowSection[];
	notes: string[];
}

// ── All 10 topics ────────────────────────────────────────

export const docsTopics: DocsTopic[] = [
	// 1. Asset Pipeline + HMR
	{
		slug: 'asset-pipeline',
		title: 'Preview updates',
		description: 'Saved files reach durable storage and refresh the preview.',
		tagline: 'File saves and hot updates',
		accent: 'asset',
		laneDescription: 'The editor writes files, the coordinator broadcasts changes, and preview requests transform source on demand.',
		sections: [
			{
				label: 'Save path',
				labelColor: 'asset',
				nodes: [
					{ id: 'ap-editor-ui', name: 'Editor UI', detail: 'edit & save', color: 'text' },
					{ id: 'ap-host-worker-1', name: 'Host Worker', detail: 'handleAPI()', color: 'orange' },
					{ id: 'ap-do-filesystem-1', name: 'DO Filesystem', detail: 'Durable Object', color: 'magenta' },
					{ id: 'ap-project-coordinator-1', name: 'ProjectCoordinator', detail: 'triggerUpdate()', color: 'ws' },
					{ id: 'ap-preview-1', name: 'Preview', detail: 'update / reload', color: 'text' },
				],
				edges: [
					{ id: 'ap-e1', source: 'ap-editor-ui', target: 'ap-host-worker-1', label: 'PUT /api/file', color: 'asset' },
					{ id: 'ap-e2', source: 'ap-host-worker-1', target: 'ap-do-filesystem-1', label: 'fs.writeFile()', color: 'magenta' },
					{ id: 'ap-e3', source: 'ap-host-worker-1', target: 'ap-project-coordinator-1', label: 'triggers HMR', color: 'asset' },
					{ id: 'ap-e4', source: 'ap-project-coordinator-1', target: 'ap-preview-1', label: 'HmrUpdateMessage', color: 'ws' },
				],
			},
			{
				label: 'Asset request',
				labelColor: 'orange',
				nodes: [
					{ id: 'ap-preview-2', name: 'Preview', detail: 'GET /src/main.ts', color: 'text' },
					{ id: 'ap-host-worker-2', name: 'Host Worker', detail: 'serveFile()', color: 'orange' },
					{ id: 'ap-do-filesystem-2', name: 'DO Filesystem', detail: 'read source', color: 'magenta' },
					{ id: 'ap-esbuild-1', name: 'esbuild-wasm', detail: 'TS→JS transform', color: 'yellow' },
					{ id: 'ap-preview-2b', name: 'Preview', detail: 'receives JS', color: 'text' },
				],
				edges: [
					{ id: 'ap-e5', source: 'ap-preview-2', target: 'ap-host-worker-2', label: 'HTTP request', color: 'orange' },
					{ id: 'ap-e6', source: 'ap-host-worker-2', target: 'ap-do-filesystem-2', label: 'fs.readFile()', color: 'magenta' },
					{ id: 'ap-e7', source: 'ap-host-worker-2', target: 'ap-esbuild-1', label: 'transform TS→JS', color: 'yellow' },
					{ id: 'ap-e9', source: 'ap-host-worker-2', target: 'ap-preview-2b', label: '200 OK', color: 'asset' },
				],
			},
		],
		notes: [],
	},

	// 2. Worker Execution
	{
		slug: 'worker-execution',
		title: 'Worker runtime',
		description: 'Preview requests execute project worker code.',
		tagline: 'Preview API execution',
		accent: 'worker',
		laneDescription: 'Preview routes collect worker files, bundle them, and run the result in an isolated runtime.',
		sections: [
			{
				nodes: [
					{ id: 'we-preview', name: 'Preview', detail: "fetch('/api/items')", color: 'text' },
					{ id: 'we-host', name: 'Host Worker', detail: 'handlePreviewAPI()', color: 'orange' },
					{ id: 'we-do-fs', name: 'DO Filesystem', detail: 'read worker/ files', color: 'magenta' },
					{ id: 'we-esbuild', name: 'esbuild-wasm', detail: 'transformCode()', color: 'yellow' },
					{ id: 'we-loader', name: 'Worker Loader', detail: 'dynamic V8 isolate', color: 'worker' },
					{ id: 'we-preview-resp', name: 'Preview', detail: 'receives JSON', color: 'text' },
				],
				edges: [
					{ id: 'we-e1', source: 'we-preview', target: 'we-host', label: '/preview/api/*', color: 'worker' },
					{ id: 'we-e2', source: 'we-host', target: 'we-do-fs', label: 'collectFiles()', color: 'magenta' },
					{ id: 'we-e3', source: 'we-host', target: 'we-esbuild', label: 'bundle input', color: 'yellow' },
					{ id: 'we-e4', source: 'we-esbuild', target: 'we-loader', label: 'runs in isolate', color: 'worker' },
					{ id: 'we-e5', source: 'we-loader', target: 'we-preview-resp', label: '200 OK', color: 'worker' },
				],
			},
		],
		notes: ['Editor UI writes <code>worker/</code> files to DO Filesystem via Host Worker (same as Asset Pipeline save path).'],
	},

	// 3. WebSocket Feedback
	{
		slug: 'websocket-feedback',
		title: 'Runtime feedback',
		description: 'Logs, errors, and runtime events reach connected clients.',
		tagline: 'Logs and errors over WebSockets',
		accent: 'ws',
		laneDescription: 'Runtime sources send messages through the project coordinator for shared editor state.',
		sections: [
			{
				nodes: [
					{ id: 'ws-worker-loader', name: 'Worker Loader', detail: 'console.log()', color: 'worker' },
					{ id: 'ws-log-tailer', name: 'LogTailer', detail: 'tail() handler', color: 'ws' },
					{ id: 'ws-host-worker', name: 'Host Worker', detail: 'catch error', color: 'orange' },
					{ id: 'ws-coordinator', name: 'ProjectCoordinator', detail: 'sendToAll()', color: 'ws' },
					{ id: 'ws-editor-ui', name: 'Editor UI', detail: 'console / overlay', color: 'text' },
				],
				edges: [
					{ id: 'ws-e1', source: 'ws-worker-loader', target: 'ws-log-tailer', label: 'tail binding', color: 'ws' },
					{ id: 'ws-e2', source: 'ws-log-tailer', target: 'ws-coordinator', label: 'ServerLogsMessage', color: 'ws' },
					{ id: 'ws-e3', source: 'ws-host-worker', target: 'ws-coordinator', label: 'ServerErrorMessage', color: 'red' },
					{ id: 'ws-e4', source: 'ws-coordinator', target: 'ws-editor-ui', label: 'WS broadcast', color: 'ws' },
				],
			},
		],
		notes: [],
	},

	// 4. Dependency Resolution
	{
		slug: 'dependency-resolution',
		title: 'Dependency Resolution',
		description: 'Project imports resolve to local files or CDN-backed packages.',
		tagline: 'Imports and CDN packages',
		accent: 'cyan',
		laneDescription: 'The preview and bundler resolve imports against project files, aliases, and registered dependencies.',
		sections: [
			{
				label: 'Import resolution',
				labelColor: 'cyan',
				nodes: [
					{ id: 'dr-source', name: 'Source Code', detail: 'import "react"', color: 'text' },
					{ id: 'dr-vfs-plugin', name: 'Resolver', detail: 'bare import check', color: 'yellow' },
					{ id: 'dr-project-meta', name: 'package.json', detail: 'dependencies map', color: 'magenta' },
					{ id: 'dr-esm-cdn-plugin', name: 'CDN loader', detail: 'module fetch', color: 'cyan' },
					{ id: 'dr-esm-cdn', name: 'esm.sh CDN', detail: 'react@19.0.0', color: 'cyan' },
					{ id: 'dr-esbuild', name: 'esbuild-wasm', detail: 'bundleWithCdn()', color: 'yellow' },
				],
				edges: [
					{ id: 'dr-e1', source: 'dr-source', target: 'dr-vfs-plugin', label: 'onResolve', color: 'yellow' },
					{ id: 'dr-e2', source: 'dr-vfs-plugin', target: 'dr-project-meta', label: 'lookup version', color: 'magenta' },
					{ id: 'dr-e3', source: 'dr-vfs-plugin', target: 'dr-esm-cdn-plugin', label: 'rewrite to CDN URL', color: 'cyan' },
					{ id: 'dr-e4', source: 'dr-esm-cdn-plugin', target: 'dr-esm-cdn', label: 'fetch + cache', color: 'cyan' },
					{ id: 'dr-e5', source: 'dr-esm-cdn', target: 'dr-esbuild', label: 'module payload', color: 'cyan' },
				],
			},
		],
		notes: [
			'Dependencies are managed via <code>package.json</code>. Unregistered imports trigger an error prompting users to add the dependency via the Dependencies panel.',
		],
	},

	// 5. Git Integration
	{
		slug: 'git-integration',
		title: 'Git workflow',
		description: 'Git actions operate on the durable project tree and refresh client state.',
		tagline: 'Artifacts-backed git flow',
		accent: 'emerald',
		laneDescription:
			'Routes call Git RPCs on the filesystem Durable Object, where Git uses the durable project tree and pushes history changes to Artifacts.',
		sections: [
			{
				label: 'Git operations',
				labelColor: 'emerald',
				nodes: [
					{ id: 'gi-git-panel', name: 'Git Panel', detail: 'stage / commit', color: 'text' },
					{ id: 'gi-host', name: 'Host Worker', detail: 'git-routes.ts', color: 'orange' },
					{ id: 'gi-project-fs', name: 'DurableObjectFilesystem', detail: 'queued Git RPCs', color: 'magenta' },
					{ id: 'gi-git-service', name: 'GitService', detail: 'isomorphic-git in DO', color: 'emerald' },
					{ id: 'gi-workspace', name: 'Computer Workspace', detail: 'durable tree + .git', color: 'emerald' },
					{ id: 'gi-artifacts', name: 'Cloudflare Artifacts', detail: 'git remote + repo tokens', color: 'emerald' },
				],
				edges: [
					{ id: 'gi-e1', source: 'gi-git-panel', target: 'gi-host', label: 'POST /api/git/*', color: 'emerald' },
					{ id: 'gi-e2', source: 'gi-host', target: 'gi-project-fs', label: 'git* RPC', color: 'magenta' },
					{ id: 'gi-e3', source: 'gi-project-fs', target: 'gi-git-service', label: 'shared mutation queue', color: 'emerald' },
					{ id: 'gi-e4', source: 'gi-git-service', target: 'gi-workspace', label: 'stage / commit / diff', color: 'emerald' },
					{ id: 'gi-e5', source: 'gi-git-service', target: 'gi-artifacts', label: 'fetch / push via repo token', color: 'emerald' },
				],
			},
			{
				label: 'Status updates',
				labelColor: 'ws',
				nodes: [
					{ id: 'gi-expiring-fs-2', name: 'Git route', detail: 'broadcastGitStatusChanged()', color: 'magenta' },
					{ id: 'gi-coordinator', name: 'ProjectCoordinator', detail: 'sendMessage()', color: 'ws' },
					{ id: 'gi-git-panel-2', name: 'Git Panel', detail: 'refetch status', color: 'text' },
				],
				edges: [
					{ id: 'gi-e6', source: 'gi-expiring-fs-2', target: 'gi-coordinator', label: 'RPC', color: 'ws' },
					{ id: 'gi-e7', source: 'gi-coordinator', target: 'gi-git-panel-2', label: 'git-status-changed', color: 'ws' },
				],
			},
		],
		notes: [
			'<code>GitService</code> runs <code>isomorphic-git</code> inside the filesystem Durable Object against the Computer workspace. The working tree, Git objects, refs, and index persist together under <code>/workspace</code>; Cloudflare Artifacts remains the remote. Git mutations share the workspace queue and send <code>git-status-changed</code> through ProjectCoordinator.',
		],
	},

	// 6. Agent System
	{
		slug: 'agent',
		title: 'Agent loop',
		description: 'Chat requests become tool calls, file changes, and streamed session state.',
		tagline: 'Agent sessions and tools',
		accent: 'ai',
		laneDescription: 'AgentRunner owns project sessions while one durable Think facet executes each session.',
		sections: [
			{
				label: 'Agent Loop',
				labelColor: 'ai',
				nodes: [
					{ id: 'agent-editor', name: 'Editor UI', detail: 'chat message', color: 'text' },
					{ id: 'agent-host', name: 'Host Worker', detail: 'rate limit + validate', color: 'orange' },
					{ id: 'agent-runner', name: 'AgentRunner DO', detail: 'per-project Durable Object', color: 'ai' },
					{ id: 'agent-service', name: 'SessionTurnAgent', detail: 'durable Think facet', color: 'ai' },
					{ id: 'agent-workers-ai', name: 'Workers AI', detail: 'streamText() with retry', color: 'yellow' },
					{ id: 'agent-workspace', name: 'Computer Workspace', detail: 'file tools + execution', color: 'magenta' },
				],
				edges: [
					{ id: 'agent-e1', source: 'agent-editor', target: 'agent-host', label: 'Agents SDK WebSocket', color: 'ai' },
					{ id: 'agent-e2', source: 'agent-host', target: 'agent-runner', label: 'typed RPC', color: 'ai' },
					{ id: 'agent-e3', source: 'agent-runner', target: 'agent-service', label: 'runTurn(submit)', color: 'ai' },
					{ id: 'agent-e4', source: 'agent-service', target: 'agent-workers-ai', label: 'LLM call', color: 'yellow' },
					{ id: 'agent-e5', source: 'agent-service', target: 'agent-workspace', label: 'tool execution', color: 'magenta' },
				],
			},
			{
				label: 'State sync',
				labelColor: 'ws',
				nodes: [
					{ id: 'agent-runner-2', name: 'AgentRunner DO', detail: 'buffer + index chunks', color: 'ai' },
					{ id: 'agent-coordinator', name: 'Agents SDK', detail: 'durable state sync', color: 'ws' },
					{ id: 'agent-editor-2', name: 'Editor UI', detail: 'useAgent + Agents SDK', color: 'text' },
				],
				edges: [
					{ id: 'agent-e6', source: 'agent-runner-2', target: 'agent-coordinator', label: 'setState()', color: 'ws' },
					{ id: 'agent-e7', source: 'agent-coordinator', target: 'agent-editor-2', label: 'state update', color: 'ws' },
				],
			},
		],
		notes: [
			'AgentRunner is the project-scoped authorization and session facade. Each session executes through one <code>SessionTurnAgent</code> Think facet, whose durable submission queue owns admission, cancellation, and recovery. Modes are <code>code</code>, <code>plan</code>, and <code>ask</code>; code mode creates file snapshots before mutations.',
		],
	},

	// 7. Test Runner
	{
		slug: 'test-runner',
		title: 'Test Runner',
		description: 'Project tests run in isolated preview infrastructure.',
		tagline: 'Built-in test execution',
		accent: 'test',
		laneDescription: 'Test files are bundled with a lightweight harness and results are broadcast to clients.',
		sections: [
			{
				label: 'Test Execution',
				labelColor: 'test',
				nodes: [
					{ id: 'tr-tests-panel', name: 'Tests Panel', detail: 'run all / file / test', color: 'text' },
					{ id: 'tr-host', name: 'Host Worker', detail: 'discover + collect', color: 'orange' },
					{ id: 'tr-esbuild', name: 'esbuild-wasm', detail: 'harness + test file', color: 'yellow' },
					{ id: 'tr-loader', name: 'WorkerLoader', detail: 'sandboxed V8 isolate', color: 'worker' },
					{ id: 'tr-tests-panel-resp', name: 'Tests Panel', detail: 'receives JSON results', color: 'test' },
				],
				edges: [
					{ id: 'tr-e1', source: 'tr-tests-panel', target: 'tr-host', label: 'POST /api/test/run', color: 'test' },
					{ id: 'tr-e2', source: 'tr-host', target: 'tr-esbuild', label: 'bundleWithCdn()', color: 'yellow' },
					{ id: 'tr-e3', source: 'tr-esbuild', target: 'tr-loader', label: 'runs in isolate', color: 'worker' },
					{ id: 'tr-e4', source: 'tr-loader', target: 'tr-tests-panel-resp', label: 'TestRunResponse', color: 'test' },
				],
			},
			{
				label: 'Result updates',
				labelColor: 'ws',
				nodes: [
					{ id: 'tr-host-2', name: 'Host Worker', detail: 'sendMessage()', color: 'orange' },
					{ id: 'tr-coordinator', name: 'ProjectCoordinator', detail: 'WS broadcast', color: 'ws' },
					{ id: 'tr-tests-panel-2', name: 'Tests Panel', detail: 'merge into cache', color: 'text' },
				],
				edges: [
					{ id: 'tr-e5', source: 'tr-host-2', target: 'tr-coordinator', label: 'RPC', color: 'ws' },
					{ id: 'tr-e6', source: 'tr-coordinator', target: 'tr-tests-panel-2', label: 'test-results-changed', color: 'ws' },
				],
			},
		],
		notes: [
			"Tests use a built-in <code>describe</code>/<code>it</code>/<code>expect</code> harness — no Vitest or Jest dependency. Each test file is bundled with the harness and executed server-side in an isolated WorkerLoader sandbox. The AI agent's <code>test_run</code> tool shares the same runner.",
		],
	},

	// 8. Deploy Pipeline
	{
		slug: 'deploy-pipeline',
		title: 'Deploy Pipeline',
		description: 'Projects are packaged and published to Cloudflare Workers.',
		tagline: 'Build and publish',
		accent: 'deploy',
		laneDescription: 'Deploy reads project config, bundles worker and frontend code, uploads assets, and returns the workers.dev URL.',
		sections: [
			{
				label: 'Deploy flow',
				labelColor: 'deploy',
				nodes: [
					{ id: 'dp-deploy-modal', name: 'Deploy Modal', detail: 'credentials + deploy', color: 'text' },
					{ id: 'dp-host', name: 'Host Worker', detail: 'collectProjectFiles()', color: 'orange' },
					{ id: 'dp-do-fs', name: 'DO Filesystem', detail: 'worker/ + src/ files', color: 'magenta' },
					{ id: 'dp-esbuild', name: 'esbuild-wasm', detail: 'worker + frontend bundles', color: 'yellow' },
					{ id: 'dp-cf-api', name: 'Cloudflare API', detail: 'Direct Upload + Script PUT', color: 'deploy' },
					{ id: 'dp-deploy-modal-resp', name: 'Deploy Modal', detail: 'receives worker URL', color: 'text' },
				],
				edges: [
					{ id: 'dp-e1', source: 'dp-deploy-modal', target: 'dp-host', label: 'POST /api/deploy', color: 'deploy' },
					{ id: 'dp-e2', source: 'dp-host', target: 'dp-do-fs', label: 'read all files', color: 'magenta' },
					{ id: 'dp-e3', source: 'dp-host', target: 'dp-esbuild', label: 'esbuild bundle', color: 'yellow' },
					{ id: 'dp-e4', source: 'dp-esbuild', target: 'dp-cf-api', label: 'upload to Cloudflare', color: 'deploy' },
					{ id: 'dp-e5', source: 'dp-cf-api', target: 'dp-deploy-modal-resp', label: 'workerUrl', color: 'deploy' },
				],
			},
		],
		notes: [
			'Static assets are uploaded via the Direct Upload API (content-hashed manifest + batched uploads), then the bundled worker script is deployed with a completion JWT linking assets to the script. Asset settings (<code>not_found_handling</code>, <code>html_handling</code>, <code>run_worker_first</code>) from the project configuration are included in the deploy metadata. Credentials are stored client-side in localStorage.',
		],
	},

	// 9. Snapshots + Revert
	{
		slug: 'snapshots',
		title: 'Snapshots',
		description: 'Agent edits keep enough history for review and revert operations.',
		tagline: 'Reviewable file changes',
		accent: 'snapshot',
		laneDescription: 'Code-mode agent runs capture before-content and review actions can keep or revert changes.',
		sections: [
			{
				label: 'Snapshot creation',
				labelColor: 'snapshot',
				nodes: [
					{ id: 'sn-agent-service', name: 'SessionTurnAgent', detail: 'code mode turn', color: 'ai' },
					{ id: 'sn-snapshot-fn', name: 'addFileToSnapshot()', detail: 'saves before-content', color: 'snapshot' },
					{ id: 'sn-snapshot-dir', name: '.agent/snapshots/', detail: 'metadata.json + files', color: 'magenta' },
				],
				edges: [
					{ id: 'sn-e1', source: 'sn-agent-service', target: 'sn-snapshot-fn', label: 'file mutation', color: 'snapshot' },
					{ id: 'sn-e2', source: 'sn-snapshot-fn', target: 'sn-snapshot-dir', label: 'fs.writeFile()', color: 'magenta' },
				],
			},
			{
				label: 'Revert flow',
				labelColor: 'snapshot',
				nodes: [
					{ id: 'sn-editor', name: 'Editor UI', detail: 'revert snapshot', color: 'text' },
					{ id: 'sn-host', name: 'Host Worker', detail: 'restore files', color: 'orange' },
					{ id: 'sn-do-fs', name: 'DO Filesystem', detail: 'overwrites with backup', color: 'magenta' },
				],
				edges: [
					{ id: 'sn-e3', source: 'sn-editor', target: 'sn-host', label: 'POST /api/snapshot/revert', color: 'snapshot' },
					{ id: 'sn-e4', source: 'sn-host', target: 'sn-do-fs', label: 'fs.writeFile()', color: 'magenta' },
				],
			},
		],
		notes: [
			'Snapshots are created automatically for AI <code>code</code> mode runs. Reverts and review rejections restore saved content and trigger preview updates through the ProjectCoordinator.',
		],
	},

	// 10. Real-time Collaboration
	{
		slug: 'collaboration',
		title: 'Real-time Collaboration',
		description: 'Collaborators share cursors, edits, and project events.',
		tagline: 'Shared project sockets',
		accent: 'collab',
		laneDescription: 'Each project uses a coordinator socket hub for participant state and live updates.',
		sections: [
			{
				nodes: [
					{ id: 'co-editor-a', name: 'Editor A', detail: 'cursor-update', color: 'collab' },
					{ id: 'co-editor-b', name: 'Editor B', detail: 'file-edit', color: 'collab' },
					{ id: 'co-coordinator', name: 'ProjectCoordinator', detail: 'hibernating WS hub', color: 'ws' },
					{ id: 'co-all-editors', name: 'All Editors', detail: 'synchronized state', color: 'text' },
				],
				edges: [
					{
						id: 'co-e1',
						source: 'co-editor-a',
						target: 'co-coordinator',
						label: 'cursor position + selection',
						color: 'collab',
					},
					{ id: 'co-e2', source: 'co-editor-b', target: 'co-coordinator', label: 'path + content', color: 'asset' },
					{ id: 'co-e3', source: 'co-coordinator', target: 'co-all-editors', label: 'broadcast to all', color: 'ws' },
				],
			},
		],
		notes: [
			'ProjectCoordinator is keyed by <code>project:&lt;id&gt;</code> and uses WebSocket hibernation. <code>collab-join</code> returns <code>collab-state</code> with the caller id, color, and current participants.',
		],
	},
];

export function getTopicBySlug(slug: string): DocsTopic | undefined {
	return docsTopics.find((topic) => topic.slug === slug);
}
