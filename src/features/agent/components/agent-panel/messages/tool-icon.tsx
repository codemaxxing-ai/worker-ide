import {
	Bot,
	CheckSquare,
	Database,
	FileText,
	FlaskConical,
	Globe,
	HelpCircle,
	Image,
	ListTodo,
	Map as MapIcon,
	Settings,
	SquareTerminal,
	Terminal,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import type { ToolName } from '@shared/validation';

export function ToolIcon({ name, className }: { name: ToolName; className?: string }) {
	switch (name) {
		case 'user_question': {
			return <HelpCircle className={cn('size-3', className)} />;
		}
		case 'web_fetch':
		case 'docs_search': {
			return <Globe className={cn('size-3', className)} />;
		}
		case 'browser_execute':
		case 'cdp_eval':
		case 'browser_markdown':
		case 'browser_extract':
		case 'browser_links':
		case 'browser_scrape': {
			return <Globe className={cn('size-3', className)} />;
		}
		case 'todos_get': {
			return <ListTodo className={cn('size-3', className)} />;
		}
		case 'todos_update': {
			return <CheckSquare className={cn('size-3', className)} />;
		}
		case 'plan_update': {
			return <MapIcon className={cn('size-3', className)} />;
		}
		case 'test_run': {
			return <FlaskConical className={cn('size-3', className)} />;
		}
		case 'asset_settings_get':
		case 'asset_settings_update': {
			return <Settings className={cn('size-3', className)} />;
		}
		case 'bindings_get':
		case 'bindings_update': {
			return <Database className={cn('size-3', className)} />;
		}
		case 'image_generate': {
			return <Image className={cn('size-3', className)} />;
		}
		case 'sub_agent': {
			return <Bot className={cn('size-3', className)} />;
		}
		case 'bash': {
			return <Terminal className={cn('size-3', className)} />;
		}
		case 'codemode': {
			return <SquareTerminal className={cn('size-3', className)} />;
		}
		default: {
			return <FileText className={cn('size-3', className)} />;
		}
	}
}
