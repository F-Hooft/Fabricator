export function validateBaseUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('LLM server URL must be a valid HTTP or HTTPS URL.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('LLM server URL must use HTTP or HTTPS.');
	}
	const hostname = url.hostname.toLocaleLowerCase();
	const isIpv4Loopback = /^127(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}$/.test(hostname);
	const isLoopback = hostname === 'localhost' || hostname === '[::1]' || isIpv4Loopback;
	if (url.protocol === 'http:' && !isLoopback) {
		throw new Error('LLM server URLs outside localhost must use HTTPS.');
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error('LLM server URL must not contain credentials, a query string, or a fragment.');
	}
	url.pathname = url.pathname.replace(/\/+$/, '');
	return url;
}

export function buildEndpointUrl(baseUrl: URL, endpoint: 'models' | 'chat/completions'): string {
	const url = new URL(baseUrl);
	const basePath = url.pathname.replace(/\/+$/, '');
	url.pathname = basePath.endsWith('/v1')
		? `${basePath}/${endpoint}`
		: `${basePath}/v1/${endpoint}`;
	return url.toString();
}
