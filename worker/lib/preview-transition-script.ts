import type { RuntimeDecision } from '@shared/runtime-status';

/** Reload a warm replacement in the same browsing context, with a bounded local handover. */
export function previewTransitionScript(decision: RuntimeDecision, ideOrigin: string, projectId: string): string {
	const configuration = JSON.stringify({ ...decision, ideOrigin, projectId }).replaceAll('<', String.raw`\u003c`);
	return String.raw`(function(configuration) {
		var key = '__worker_ide_handover:' + configuration.projectId;
		var switching = false;
		var hooks = function() { return window.__WORKER_IDE_PREVIEW_STATE__; };
		var fields = function() { return Array.from(document.querySelectorAll('input, textarea, select')).filter(function(field) { return !['password','file','hidden'].includes(field.type); }); };
		var bounded = function(value) { try { var text = JSON.stringify(value); return text && new TextEncoder().encode(text).byteLength <= 1048576 ? text : undefined; } catch (_) { return undefined; } };
		var settle = function(value) { return Promise.race([Promise.resolve(value), new Promise(function(resolve) { setTimeout(resolve,750); })]); };
		var frame = function() { return new Promise(function(resolve) { requestAnimationFrame(resolve); }); };
		var send = function(message) { if (parent !== window) parent.postMessage(message, configuration.ideOrigin); };
		var save = function(backend,application) {
			try {
				var saved = {backend:backend,previousBackend:configuration.backend,timestamp:Date.now(),path:location.pathname + location.search,scrollX:scrollX,scrollY:scrollY,application:application,fields:fields().slice(0,200).map(function(field,index) { return {id:field.id,name:field.name,index:index,tag:field.tagName,type:field.type,value:field.value,checked:field.checked,focused:document.activeElement===field}; })};
				var text = bounded(saved);
				if (!text) { delete saved.application; text = bounded(saved); }
				if (text) sessionStorage.setItem(key,text);
			} catch (_) {}
		};
		var restore = async function() {
			var saved;
			try {
				var text = sessionStorage.getItem(key);
				sessionStorage.removeItem(key);
				if (text && new TextEncoder().encode(text).byteLength <= 1048576) saved = JSON.parse(text);
			} catch (_) {}
			try {
			if (saved && saved.path === location.pathname + location.search && (saved.backend === configuration.backend || (saved.backend === 'auto' && saved.previousBackend !== configuration.backend)) && Date.now() - saved.timestamp >= 0 && Date.now() - saved.timestamp < 300000) {
				await frame();
				try { if (hooks() && typeof hooks().restore === 'function') await settle(hooks().restore(saved.application)); } catch (_) {}
				await frame();
				var current = fields();
				for (var field of Array.isArray(saved.fields) ? saved.fields.slice(0,200) : []) {
					if (!field || typeof field.value !== 'string') continue;
					var element = current.find(function(candidate, index) { return candidate.tagName === field.tag && candidate.type === field.type && (field.id ? candidate.id === field.id : field.name ? candidate.name === field.name && index === field.index : index === field.index); });
					if (!element || ['password','file','hidden'].includes(element.type)) continue;
					var prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
					var setter = Object.getOwnPropertyDescriptor(prototype, 'value');
					if (setter && setter.set) setter.set.call(element, field.value);
					var checked = Object.getOwnPropertyDescriptor(prototype, 'checked');
					if (checked && checked.set && typeof field.checked === 'boolean') checked.set.call(element, field.checked);
					element.dispatchEvent(new Event('input', {bubbles:true}));
					element.dispatchEvent(new Event('change', {bubbles:true}));
					if (field.focused) element.focus({preventScroll:true});
				}
				requestAnimationFrame(function() { scrollTo(saved.scrollX, saved.scrollY); });
			}
			} catch (_) {}
			send({type:'__preview-runtime-ready', backend:configuration.backend, generation:configuration.generation});
		};
		var transition = async function(backend) {
			if (switching || backend === configuration.backend || !['worker','container'].includes(backend)) return;
			switching = true;
			try {
				var application;
				try { if (hooks() && typeof hooks().capture === 'function') application = await settle(hooks().capture()); } catch (_) {}
				save(backend,application);
			} catch (_) {}
			send({type:'__hmr-status', status:'reloading'});
			location.reload();
		};
		window.addEventListener('message', function(event) {
			if (event.source !== parent || event.origin !== configuration.ideOrigin) return;
			if (event.data && event.data.type === '__preview-runtime-switch') void transition(event.data.backend);
		});
		// A manifest/configuration edit can make the existing HMR client reload
		// before the IDE receives readiness. Capture synchronous state on that path.
		window.addEventListener('beforeunload', function() {
			if (switching) return;
			var application;
			try { if (hooks() && typeof hooks().capture === 'function') application = hooks().capture(); } catch (_) {}
			if (application && typeof application.then === 'function') application = undefined;
			save('auto',application);
		});
		if (document.readyState === 'complete') void restore();
		else window.addEventListener('load', function() { void restore(); }, {once:true});
		window.addEventListener('__preview-runtime-status', function(event) {
			if (parent !== window) return;
			var status = event.detail;
			if (status && status.preview && status.preview.phase === 'ready') void transition(status.preview.backend);
		});
	})(${configuration});`;
}
