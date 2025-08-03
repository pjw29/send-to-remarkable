import { WorkflowParams } from "./workflow";

export interface UploadResult {
	success: boolean;
	fileId: string;
	fileName: string;
	workflowId: string;
	workflowStatus: any;
	email?: string;
	error?: string;
}

export async function uploadFile(
	env: Env,
	file: File,
	authDoId: string,
	email?: string
): Promise<UploadResult> {
	console.log(`Starting file upload: ${file.name}, size: ${file.size} bytes, authDoId: ${authDoId}${email ? `, email: ${email}` : ''}`);
	
	// Verify the auth DO has a valid token
	const authDoStub = env.AUTH_DO.get(env.AUTH_DO.idFromName(authDoId));
	const isRegistered = await authDoStub.isRegistered();
	
	if (!isRegistered) {
		console.error(`Authentication check failed for authDoId: ${authDoId}`);
		throw new Error("Device not registered or authentication expired");
	}

	console.log(`Authentication verified for authDoId: ${authDoId}`);

	// Generate a unique ID for the file
	const fileId = crypto.randomUUID();
	
	console.log(`Generated file ID: ${fileId} for file: ${file.name}`);
	
	// Store the file in R2
	await env.DOCUMENT_STORAGE.put(fileId, file.stream(), {
		httpMetadata: {
			contentType: file.type,
			contentDisposition: `attachment; filename="${file.name}"`,
		},
		customMetadata: {
			originalFileName: file.name,
			uploadedBy: email || 'web-upload',
			uploadedAt: new Date().toISOString(),
			authDoId: authDoId,
		},
	});

	console.log(`File stored in R2 with ID: ${fileId}`);

	// Trigger the workflow
	const workflowParams: WorkflowParams = {
		fileId: fileId,
		fileName: file.name,
		authDoId: authDoId,
	};
	
	if (email) {
		workflowParams.email = email;
	}

	let instance = await env.MY_WORKFLOW.create({
		params: workflowParams,
	});

	const workflowStatus = await instance.status();
	console.log(`Workflow created with ID: ${instance.id}, status: ${workflowStatus.status}`);

	return {
		success: true,
		fileId: fileId,
		fileName: file.name,
		workflowId: instance.id,
		workflowStatus: workflowStatus,
		email: email,
	};
}
