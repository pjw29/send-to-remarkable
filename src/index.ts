import { Hono } from 'hono';
import { AuthDO } from "./auth-do";
import { RemarkableUploadWorkflow } from "./workflow";
import { uploadFile } from "./upload-utils";
import { env } from 'cloudflare:workers';
import * as PostalMime from 'postal-mime';

/**
 * Send to reMarkable - A Cloudflare Worker for uploading documents to reMarkable
 */

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// Serve HTML page on root
app.get('/', (c) => {
	return env.ASSETS.fetch('/index.html');
});

app.get('/signup-enabled', (c) => {
	// @ts-ignore - The exact value of the env var is in the types, so comparing it results in an error.
	return c.json({ signupEnabled: c.env.SIGNUP_DISABLED === "false" });
});

// Route to register a new device with a link code
app.post('/register', async (c) => {
	// @ts-ignore - The exact value of the env var is in the types, so comparing it results in an error.
	if (c.env.SIGNUP_DISABLED !== "false") {
		console.error('Signup is currently disabled');
		return c.json({ error: "Signup is currently disabled" }, 403);
	}
	try {
		const { linkCode } = await c.req.json();
		console.log(`Registration attempt with link code: ${linkCode}`);

		if (!linkCode) {
			console.error('Registration failed: No link code provided');
			return c.json({ error: "Link code is required" }, 400);
		}

		// Generate a unique device ID
		const deviceId = crypto.randomUUID();

		// Generate a unique ID for this AuthDO instance
		const authDoId = crypto.randomUUID();

		console.log(`Generated deviceId: ${deviceId}, authDoId: ${authDoId}`);

		// Get the AuthDO stub
		const authDoStub = c.env.AUTH_DO.get(c.env.AUTH_DO.idFromName(authDoId));

		// Register the device
		const result = await authDoStub.register(linkCode, deviceId);

		if (result.success) {
			console.log(`Device registered successfully: authId=${authDoId}, deviceId=${result.device_id}`);
			return c.json({
				success: true,
				authId: authDoId,
				message: "Device registered successfully. Use the authId for future API calls."
			});
		} else {
			console.error(`Registration failed: ${result.error}`);
			return c.json({ error: result.error }, 400);
		}
	} catch (error) {
		console.error('Registration error:', error);
		return c.json({
			error: "Registration failed",
			details: error instanceof Error ? error.message : String(error)
		}, 500);
	}
});

// Route to check authentication status
app.get('/auth/:authId/status', async (c) => {
	try {
		const authId = c.req.param('authId');
		console.log(`Checking auth status for authId: ${authId}`);

		const authDoStub = c.env.AUTH_DO.get(c.env.AUTH_DO.idFromName(authId));
		const status = await authDoStub.getStatus();

		console.log(`Auth status for ${authId}:`, status);
		return c.json(status);
	} catch (error) {
		console.error('Status check error:', error);
		return c.json({
			error: "Failed to check status",
			details: error instanceof Error ? error.message : String(error)
		}, 500);
	}
});

// Route to destroy an auth ID and its durable object
app.delete('/auth/:authId', async (c) => {
	try {
		const authId = c.req.param('authId');
		console.log(`Destroying auth for authId: ${authId}`);

		const authDoStub = c.env.AUTH_DO.get(c.env.AUTH_DO.idFromName(authId));

		// Call destroy method on the durable object
		await authDoStub.destroy();

		console.log(`Successfully destroyed auth for authId: ${authId}`);
		return c.json({
			success: true,
			message: "Authentication destroyed successfully"
		});
	} catch (error) {
		console.error('Auth destruction error:', error);
		return c.json({
			error: "Failed to destroy authentication",
			details: error instanceof Error ? error.message : String(error)
		}, 500);
	}
});

// Route to upload a file with authId directly (no email)
app.post('/upload', async (c) => {
	try {
		console.log('Received direct upload request');

		// Parse the multipart form data
		const formData = await c.req.formData();
		const file = formData.get('file') as File;
		const authId = formData.get('authId') as string;

		if (!file) {
			console.error('Upload failed: No file provided');
			return c.json({ error: "No file provided" }, 400);
		}

		if (!authId) {
			console.error('Upload failed: No authId provided');
			return c.json({ error: "authId is required" }, 400);
		}

		console.log(`Processing direct upload: file=${file.name}, authId=${authId}`);

		const result = await uploadFile(c.env, file, authId);

		console.log(`Direct upload successful: fileId=${result.fileId}, workflowId=${result.workflowId}`);
		return c.json({
			success: result.success,
			error: result.error,
			fileId: result.fileId,
		});

	} catch (error) {
		console.error('Error processing direct file upload:', error);
		return c.json({
			error: "Failed to process file upload",
			details: error instanceof Error ? error.message : String(error)
		}, 500);
	}
});

export default {
	fetch: app.fetch,

	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		const parser = new PostalMime.default();
		const rawEmail = new Response(message.raw);
		const email = await parser.parse(await rawEmail.arrayBuffer());
		console.log(`Received email from: ${email.from}, subject: ${email.subject}`);

		// Make sure we have attachments
		if (!email.attachments || email.attachments.length === 0) {
			console.error('Email has no attachments');
			message.setReject("Email must contain at least one attachment");
			return;
		}

		// We then make sure we have a `to` address ending in `@send-to-remarkable.zegs.me`, and we extract the first part as the auth ID
		if (!email.to || email.to.length === 0) {
			console.error('Email has no "to" address');
			message.setReject("Email must have a 'to' address");
			return;
		}
		const authDoId = toAddress.address?.split('@')[0];
		if (!authDoId) {
			console.error('Failed to extract authDoId from email "to" address');
			message.setReject("Failed to extract authentication ID from email address");
			return;
		}

		// Process each attachment
		for (const attachment of email.attachments) {
			console.log(`Processing attachment: ${attachment.filename}`);
			// We run the upload workflow for each attachment
			const file = new File([attachment.content], email.subject || attachment.filename || "send to remarkable upload", {
				type: attachment.mimeType || 'application/octet-stream'
			});
			await uploadFile(env, file, authDoId, email.from.address);
		}
	},
}

// Export the classes for the runtime
export { AuthDO, RemarkableUploadWorkflow };
