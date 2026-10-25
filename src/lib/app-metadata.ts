import { meta } from '../../shared/meta';

import type { ManifestOptions } from 'vite-plugin-pwa';

export const appDocumentMetadata = {
	applicationName: meta.applicationName,
	canonicalUrl: 'https://codemaxxing.app/',
	description: meta.description,
	formatDetection: 'telephone=no',
	googlebot: 'index, follow',
	locale: 'en_US',
	productName: meta.productName,
	robots: 'index, follow',
	shortName: meta.shortName,
	socialImageAlt: meta.title,
	socialImageHeight: 630,
	socialImageType: 'image/png',
	socialImageUrl: 'https://codemaxxing.app/meta/app-og.png',
	socialImageWidth: 1200,
	themeColor: '#000000',
	title: meta.title,
	twitterCard: 'summary_large_image',
	viewport: 'width=device-width, initial-scale=1.0, viewport-fit=cover',
} as const;

export const appManifestMetadata = {
	background_color: '#000000',
	description: appDocumentMetadata.description,
	display: 'standalone',
	display_override: ['window-controls-overlay'],
	icons: [
		{
			purpose: 'any',
			sizes: 'any',
			src: '/favicon.svg',
			type: 'image/svg+xml',
		},
	],
	id: '7c3a8f1e-9d4b-4e2a-b6f5-1a2d3c4e5f6a',
	name: appDocumentMetadata.productName,
	orientation: 'natural',
	scope: '/',
	short_name: appDocumentMetadata.shortName,
	start_url: '/',
	theme_color: appDocumentMetadata.themeColor,
} as const satisfies Partial<ManifestOptions>;
