import crypto from 'crypto';

const TOKEN_BYTES = 24;

export function generateInviteToken(): string {
	return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashInviteToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}
