import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	assertSafeLocalFileName,
	assertSafeObjectKey,
	FileAccessDeniedError,
	parseUploadResourceContext
} from './index.js';

test('parseUploadResourceContext requires matching resourceType for purpose', () => {
	assert.throws(
		() =>
			parseUploadResourceContext(
				{ resourceType: 'meterReading', resourceId: 'mr-1' },
				'tenant-document'
			),
		FileAccessDeniedError
	);
});

test('parseUploadResourceContext accepts managed tenant document upload', () => {
	const ctx = parseUploadResourceContext(
		{ resourceType: 'managedTenant', resourceId: 'mt-1' },
		'tenant-document'
	);
	assert.equal(ctx.resourceType, 'managedTenant');
	assert.equal(ctx.resourceId, 'mt-1');
});

test('assertSafeLocalFileName rejects path traversal', () => {
	assert.throws(() => assertSafeLocalFileName('../secret.pdf'), FileAccessDeniedError);
	assert.throws(() => assertSafeLocalFileName('a/b.pdf'), FileAccessDeniedError);
});

test('assertSafeObjectKey rejects foreign and traversal keys', () => {
	assert.throws(() => assertSafeObjectKey('../../../etc/passwd'), FileAccessDeniedError);
	assert.throws(
		() => assertSafeObjectKey('uploads/other-landlord/secret/file.jpg'),
		FileAccessDeniedError
	);
	assert.doesNotThrow(() =>
		assertSafeObjectKey(
			'uploads/tenant-documents/landlord/abc/2026/07/11111111-1111-1111-1111-111111111111.jpg'
		)
	);
});
