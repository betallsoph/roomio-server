import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { resetEnvForTests } from '../env.js';
import { encryptSecret } from '../secrets.js';
import { createPayOSSignature } from '../payos.js';
import {
	invoices,
	maintenanceRequests,
	paymentAccounts,
	paymentTransactions,
	automationJobs
} from '../db/schema.js';
import { isSessionExemptPublicRoute, listPublicRouteKeys } from './machine-routes.js';
import {
	seedSecurityFixturesFromHandle,
	type SecurityFixtureMap
} from '../testing/security-fixtures.js';
import {
	closeSecurityDbPool,
	getSecurityIntegrationSkipReason,
	withSecurityDb,
	type SecurityDbHandle
} from '../testing/test-db.js';

const skipReason = getSecurityIntegrationSkipReason();

const TEST_ENV: NodeJS.ProcessEnv = {
	NODE_ENV: 'test',
	DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://roomio:roomio@localhost:5432/roomio_test',
	PAYOS_ENC_KEY: 'per-landlord-encryption-key-at-least-32-characters',
	CRON_SECRET: 'cron-secret-value-32chars-minimum',
	BOT_TOKEN: '123456789012:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi',
	BOT_USERNAME: 'roomio_test_bot',
	MINIAPP_SHORT_NAME: 'app',
	TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret-never-log'
};

const LANDLORD_A_CHECKSUM = 'landlord-a-checksum-key-32chars!!';
const LANDLORD_B_CHECKSUM = 'landlord-b-checksum-key-32chars!!';
const ORDER_CODE_A = '987654321';
const ORDER_CODE_B = '987654322';

async function callHandler(handler: unknown, event: Record<string, unknown>): Promise<Response> {
	return (handler as (e: unknown) => Promise<Response>)(event);
}

async function readJson(response: Response): Promise<{ status: number; body: unknown }> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	return { status: response.status, body };
}

function buildPayosWebhookBody(
	data: Record<string, unknown>,
	checksumKey: string,
	overrides: Record<string, unknown> = {}
) {
	// PayOS signs the `data` object as delivered — including nested `code`.
	const signedData = { ...data, code: '00' };
	const signature = createPayOSSignature(signedData, checksumKey);
	return {
		code: '00',
		desc: 'success',
		success: true,
		data: signedData,
		signature,
		...overrides
	};
}

async function seedPayosWebhookFixture(
	handle: SecurityDbHandle,
	fixture: SecurityFixtureMap
): Promise<void> {
	const { ids } = fixture;
	await handle.db
		.update(paymentAccounts)
		.set({
			provider: 'payos',
			payosClientId: 'client-a',
			payosApiKeyEnc: encryptSecret('api-key-a'),
			payosChecksumKeyEnc: encryptSecret(LANDLORD_A_CHECKSUM)
		})
		.where(eq(paymentAccounts.id, ids.paymentAccountA.paymentAccountId));

	await handle.db
		.update(paymentAccounts)
		.set({
			provider: 'payos',
			payosClientId: 'client-b',
			payosApiKeyEnc: encryptSecret('api-key-b'),
			payosChecksumKeyEnc: encryptSecret(LANDLORD_B_CHECKSUM)
		})
		.where(eq(paymentAccounts.id, ids.paymentAccountB.paymentAccountId));

	await handle.db
		.update(invoices)
		.set({ payosOrderCode: ORDER_CODE_A, payosPaymentLinkId: 'plink-a-1' })
		.where(eq(invoices.id, ids.invoiceANow.invoiceId));

	await handle.db
		.update(invoices)
		.set({ payosOrderCode: ORDER_CODE_B, payosPaymentLinkId: 'plink-b-1' })
		.where(eq(invoices.id, ids.invoiceBNow.invoiceId));
}

async function countRows(
	handle: SecurityDbHandle,
	table: 'paymentTransactions' | 'maintenanceRequests' | 'automationJobs'
) {
	const map = {
		paymentTransactions,
		maintenanceRequests,
		automationJobs
	} as const;
	const rows = await handle.db.select({ count: sql<number>`count(*)::int` }).from(map[table]);
	return rows[0]?.count ?? 0;
}

test('AUTH-003 machine route registry keys remain exact', () => {
	assert.deepEqual(listPublicRouteKeys(), [
		'POST /api/auth',
		'POST /api/auth/telegram',
		'POST /api/cron/monthly',
		'POST /api/payment-webhook',
		'POST /api/payos-webhook',
		'POST /api/payos-webhook/subscription',
		'POST /api/telegram/webhook'
	]);
	assert.equal(isSessionExemptPublicRoute('POST', '/api/payment-webhook'), true);
	assert.equal(isSessionExemptPublicRoute('POST', '/api/payment-webhook/evil'), false);
});

if (skipReason) {
	test('AUTH-016 machine route security suite', { skip: skipReason }, () => {});
} else {
	test.after(async () => {
		await closeSecurityDbPool();
	});

	test('payment webhook rejects bad/missing/tampered signature before writes', async () => {
		resetEnvForTests(TEST_ENV);
		const { POST } = await import('../../../routes/api/payment-webhook/+server.js');

		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			await seedPayosWebhookFixture(handle, fixture);
			const before = await countRows(handle, 'paymentTransactions');

			const validData = {
				orderCode: Number(ORDER_CODE_A),
				paymentLinkId: 'plink-a-1',
				amount: 100_000,
				reference: 'txn-invalid-sig-test',
				transactionDateTime: '2026-07-30T10:00:00',
				description: 'test'
			};

			const missingSig = await callHandler(POST, {
				request: new Request('http://localhost/api/payment-webhook', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ data: validData })
				}),
				locals: { requestId: 'req-missing-sig' }
			});
			assert.equal((await readJson(missingSig)).status, 400);
			assert.equal(await countRows(handle, 'paymentTransactions'), before);

			const tampered = buildPayosWebhookBody(validData, LANDLORD_A_CHECKSUM);
			tampered.signature = 'deadbeef'.repeat(8);
			const tamperedRes = await callHandler(POST, {
				request: new Request('http://localhost/api/payment-webhook', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(tampered)
				}),
				locals: { requestId: 'req-tampered-sig' }
			});
			assert.equal((await readJson(tamperedRes)).status, 401);
			assert.equal(await countRows(handle, 'paymentTransactions'), before);
		});
	});

	test('payment webhook unmatched invoice acks without operational write', async () => {
		resetEnvForTests(TEST_ENV);
		const { POST } = await import('../../../routes/api/payment-webhook/+server.js');

		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			await seedPayosWebhookFixture(handle, fixture);
			const before = await countRows(handle, 'paymentTransactions');

			const body = buildPayosWebhookBody(
				{
					orderCode: 111222333,
					paymentLinkId: 'unknown-plink',
					amount: 50_000,
					reference: 'txn-unmatched',
					transactionDateTime: '2026-07-30T10:00:00'
				},
				LANDLORD_A_CHECKSUM
			);

			const res = await callHandler(POST, {
				request: new Request('http://localhost/api/payment-webhook', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				}),
				locals: { requestId: 'req-unmatched' }
			});
			assert.equal((await readJson(res)).status, 200);
			assert.equal(await countRows(handle, 'paymentTransactions'), before);
		});
	});

	test('payment webhook rejects landlord B invoice signed with landlord A credential', async () => {
		resetEnvForTests(TEST_ENV);
		const { POST } = await import('../../../routes/api/payment-webhook/+server.js');

		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			await seedPayosWebhookFixture(handle, fixture);
			const before = await countRows(handle, 'paymentTransactions');

			const body = buildPayosWebhookBody(
				{
					orderCode: Number(ORDER_CODE_B),
					paymentLinkId: 'plink-b-1',
					amount: 100_000,
					reference: 'txn-cross-landlord',
					transactionDateTime: '2026-07-30T10:00:00'
				},
				LANDLORD_A_CHECKSUM
			);

			const res = await callHandler(POST, {
				request: new Request('http://localhost/api/payment-webhook', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				}),
				locals: { requestId: 'req-cross-landlord' }
			});
			assert.equal((await readJson(res)).status, 401);
			assert.equal(await countRows(handle, 'paymentTransactions'), before);
		});
	});

	test('payment webhook replay is idempotent after verified apply', async () => {
		resetEnvForTests(TEST_ENV);
		const { POST } = await import('../../../routes/api/payment-webhook/+server.js');

		await withSecurityDb(async (handle) => {
			const fixture = await seedSecurityFixturesFromHandle(handle);
			await seedPayosWebhookFixture(handle, fixture);

			const data = {
				orderCode: Number(ORDER_CODE_A),
				paymentLinkId: 'plink-a-1',
				amount: 100_000,
				reference: 'txn-replay-test',
				transactionDateTime: '2026-07-30T10:00:00',
				description: 'replay'
			};
			const body = buildPayosWebhookBody(data, LANDLORD_A_CHECKSUM);
			const payload = JSON.stringify(body);

			function webhookEvent(requestId: string) {
				return {
					request: new Request('http://localhost/api/payment-webhook', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: payload
					}),
					locals: { requestId }
				};
			}

			const first = await readJson(await callHandler(POST, webhookEvent('req-replay-1')));
			assert.equal(first.status, 200);

			const second = await readJson(await callHandler(POST, webhookEvent('req-replay-2')));
			assert.equal(second.status, 200);
			const secondBody = second.body as { message?: string };
			assert.match(secondBody.message ?? '', /đã được xử lý/);

			const rows = await handle.db
				.select({ id: paymentTransactions.id })
				.from(paymentTransactions)
				.where(eq(paymentTransactions.providerTransactionId, 'txn-replay-test'));
			assert.equal(rows.length, 1);
		});
	});

	test('telegram webhook rejects missing and tampered secret before writes', async () => {
		resetEnvForTests(TEST_ENV);

		try {
			mock.module('../telegram-bot.js', {
				namedExports: {
					sendTelegramMessage: async () => undefined,
					answerTelegramCallbackQuery: async () => undefined,
					getTelegramFilePath: async () => 'path',
					downloadTelegramFile: async () => ({ body: new Uint8Array(), contentType: 'image/jpeg' })
				}
			});

			const { POST } = await import('../../../routes/api/telegram/webhook/+server.js');

			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
				const before = await countRows(handle, 'maintenanceRequests');
				const update = {
					message: {
						message_id: 1,
						from: { id: 999_999_001 },
						chat: { id: 999_999_001 },
						text: '/suco'
					}
				};

				const missing = await callHandler(POST, {
					request: new Request('http://localhost/api/telegram/webhook', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(update)
					}),
					locals: { requestId: 'tg-missing-secret' }
				});
				assert.equal((await readJson(missing)).status, 401);
				assert.equal(await countRows(handle, 'maintenanceRequests'), before);

				const tampered = await callHandler(POST, {
					request: new Request('http://localhost/api/telegram/webhook', {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							'x-telegram-bot-api-secret-token': 'wrong-telegram-secret-value'
						},
						body: JSON.stringify(update)
					}),
					locals: { requestId: 'tg-tampered-secret' }
				});
				assert.equal((await readJson(tampered)).status, 401);
				assert.equal(await countRows(handle, 'maintenanceRequests'), before);
			});
		} finally {
			mock.restoreAll();
		}
	});

	test('telegram webhook unknown user does not create maintenance request', async () => {
		resetEnvForTests(TEST_ENV);

		try {
			mock.module('../telegram-bot.js', {
				namedExports: {
					sendTelegramMessage: async () => undefined,
					answerTelegramCallbackQuery: async () => undefined,
					getTelegramFilePath: async () => 'path',
					downloadTelegramFile: async () => ({ body: new Uint8Array(), contentType: 'image/jpeg' })
				}
			});

			const { POST } = await import('../../../routes/api/telegram/webhook/+server.js');

			await withSecurityDb(async (handle) => {
				await seedSecurityFixturesFromHandle(handle);
				const before = await countRows(handle, 'maintenanceRequests');

				const res = await callHandler(POST, {
					request: new Request('http://localhost/api/telegram/webhook', {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							'x-telegram-bot-api-secret-token': TEST_ENV.TELEGRAM_WEBHOOK_SECRET!
						},
						body: JSON.stringify({
							message: {
								message_id: 2,
								from: { id: 4242424242 },
								chat: { id: 4242424242 },
								text: '/suco'
							}
						})
					}),
					locals: { requestId: 'tg-unknown-user' }
				});
				assert.equal((await readJson(res)).status, 200);
				assert.equal(await countRows(handle, 'maintenanceRequests'), before);
			});
		} finally {
			mock.restoreAll();
		}
	});

	test('cron monthly rejects bad secret before enqueueing scoped jobs', async () => {
		resetEnvForTests(TEST_ENV);
		const { POST } = await import('../../../routes/api/cron/monthly/+server.js');

		await withSecurityDb(async (handle) => {
			await seedSecurityFixturesFromHandle(handle);
			const before = await countRows(handle, 'automationJobs');

			const missing = await callHandler(POST, {
				request: new Request('http://localhost/api/cron/monthly', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ draft: false })
				}),
				locals: { requestId: 'cron-missing-secret' }
			});
			assert.equal((await readJson(missing)).status, 401);
			assert.equal(await countRows(handle, 'automationJobs'), before);

			const tampered = await callHandler(POST, {
				request: new Request('http://localhost/api/cron/monthly', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-cron-secret': 'wrong-cron-secret-value-32chars'
					},
					body: JSON.stringify({ draft: false })
				}),
				locals: { requestId: 'cron-tampered-secret' }
			});
			assert.equal((await readJson(tampered)).status, 401);
			assert.equal(await countRows(handle, 'automationJobs'), before);
		});
	});
}
