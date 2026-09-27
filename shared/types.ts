export { type FileInfo, type FileTreeNode, type OpenFile, type CursorPosition, type SelectionRange } from './types/file-system';

export {
	type AgentMode,
	type ToolErrorInfo,
	type ToolMetadataInfo,
	type AiSession,
	type AiSessionSummary,
	type AgentSessionStatus,
	type TodoItem,
	type TextPart,
	type PreviewElementAttributes,
	type PreviewElementReference,
	type PreviewElementPart,
	type ImagePart,
	type ToolCallPart,
	type ToolResultPart,
	type ReasoningPart,
	type UserMessagePart,
	type MessagePart,
	type ChatMessage,
} from './types/agent';

export {
	type ReviewHunkStatus,
	type ReviewResolutionDecision,
	type ChangeSetFile,
	type ChangeSet,
	type ReviewEntry,
	type ReviewSummary,
	type PendingFileChange,
	type FileChange,
	type SnapshotMetadata,
	type SnapshotSummary,
} from './types/review';

export {
	type Participant,
	type HmrUpdate,
	createHmrUpdateForFile,
	type DependencyError,
	type SourceLocation,
	type ServerError,
	type ServerLogEntry,
} from './types/collaboration';

export {
	type ProjectTemplateMeta,
	type FilesResponse,
	type FileResponse,
	type ExpirationResponse,
	type NewProjectResponse,
	type NotFoundHandling,
	type HtmlHandling,
	type AssetSettings,
	type ResolvedAssetSettings,
	resolveAssetSettings,
	type BindingsConfig,
} from './types/project';

export {
	type DiscoveredTest,
	type DiscoveredTestFile,
	type TestResultEntry,
	type TestSuiteResult,
	type TestFileResult,
	type TestRunResponse,
	mergeTestRunResults,
} from './types/test-run';

export {
	type GitFileStatus,
	type GitStatusEntry,
	type GitBranchInfo,
	type GitAuthor,
	type GitCommitEntry,
	type GitGraphConnection,
	type GitGraphEntry,
	type GitDiffLine,
	type GitDiffHunk,
	type GitFileDiff,
	type GitMergeResult,
} from './types/git';
