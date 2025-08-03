import {
	WorkflowEntrypoint,
	WorkflowEvent,
	WorkflowStep,
} from "cloudflare:workers";

// User-defined params passed to your Workflow
export type WorkflowParams = {
	email?: string;
	fileId: string;
	fileName: string;
	authDoId: string;
};

export class RemarkableUploadWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
	async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
		console.log(`Starting workflow for file ${event.payload.fileName} with authDoId ${event.payload.authDoId}`);
		
		const fileInfo = await step.do("retrieve file info", async () => {
			// Access the file from R2 storage
			const file = await this.env.DOCUMENT_STORAGE.get(event.payload.fileId);
			if (!file) {
				throw new Error(`File with ID ${event.payload.fileId} not found`);
			}
			
			console.log(`Retrieved file info: ${event.payload.fileName}, size: ${file.size} bytes`);
			
			return {
				email: event.payload.email,
				fileId: event.payload.fileId,
				fileName: event.payload.fileName,
				fileSize: file.size,
				lastModified: file.uploaded,
				authDoId: event.payload.authDoId
			};
		});

		// Get access token from the AuthDO
		const authInfo = await step.do("get authentication", async () => {
			console.log(`Getting access token from AuthDO: ${event.payload.authDoId}`);
			const authDoStub = this.env.AUTH_DO.get(this.env.AUTH_DO.idFromName(event.payload.authDoId));
			const accessToken = await authDoStub.getAccessToken();
			
			if (!accessToken) {
				throw new Error("No valid access token available. Device may not be registered.");
			}
			
			console.log(`Successfully retrieved access token (length: ${accessToken.length})`);
			return { accessToken };
		});

		// Upload to reMarkable API
		const apiResponse = await step.do("upload to reMarkable API", async () => {
			console.log(`Starting upload to reMarkable API for file: ${fileInfo.fileName}`);
			
			// Get the file from R2 storage
			const file = await this.env.DOCUMENT_STORAGE.get(event.payload.fileId);
			if (!file) {
				throw new Error(`File with ID ${event.payload.fileId} not found in R2`);
			}

			// Get the content type from R2 metadata
			const contentType = file.httpMetadata?.contentType || 'application/octet-stream';
			
			// Prepare the rM-Meta header - base64 encoded JSON
			const rmMeta = {
				parent: "",
				file_name: fileInfo.fileName
			};
			const rmMetaBase64 = btoa(JSON.stringify(rmMeta));

			console.log(`Making request to reMarkable API with Content-Type: ${contentType}`);

			// Make the request to reMarkable API
			const response = await fetch('https://eu.tectonic.remarkable.com/doc/v2/files', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${authInfo.accessToken}`,
					'Content-Type': contentType,
					'rM-Meta': rmMetaBase64
				},
				body: file.body
			});

			if (!response.ok) {
				const errorText = await response.text();
				console.error(`reMarkable API error (${response.status}): ${errorText}`);
				throw new Error(`reMarkable API error (${response.status}): ${errorText}`);
			}

			const result = await response.json() as any;
			console.log(`Successfully uploaded file ${fileInfo.fileName} to reMarkable${fileInfo.email ? ` for ${fileInfo.email}` : ''}`);
			
			return { 
				success: true as const, 
				uploaded: new Date().toISOString(),
				remarkableResponse: result as Record<string, any>
			};
		});

		console.log(`Upload successful, waiting 24 hours before cleanup for file: ${fileInfo.fileName}`);
		await step.sleep("wait before cleanup", "24 hours");

		await step.do(
			"cleanup and delete file",
			async () => {
				console.log(`Starting cleanup for file ${fileInfo.fileName} (ID: ${fileInfo.fileId})`);
				
				try {
					// Delete the file from R2 storage
					await this.env.DOCUMENT_STORAGE.delete(fileInfo.fileId);
					console.log(`Successfully deleted file ${fileInfo.fileName} from R2 storage`);
				} catch (error) {
					console.error(`Failed to delete file ${fileInfo.fileName} from R2:`, error);
					throw error;
				}
			},
		);

		console.log(`Workflow completed successfully for file: ${fileInfo.fileName}`);
	}
}
