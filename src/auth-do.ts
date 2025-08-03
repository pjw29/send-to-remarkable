import { DurableObject } from "cloudflare:workers";
import { RegisterResult, AuthError, AuthStatus } from "./types";

const ENDPOINT_DISCOVERY_URL = "https://internal.cloud.remarkable.com/discovery/v1/endpoints";

/**
 * AuthDO is a Durable Object that manages device registration and authentication
 * for the reMarkable Connect API. It handles device identity, token management
 * (including refresh), and provides access tokens for API calls.
 */
export class AuthDO extends DurableObject<Env> {
    private access_token: string | null = null;
    private sync_host!: string;
    private auth_host!: string;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        this.ctx.blockConcurrencyWhile(async () => {
            console.log("Initializing AuthDO...");
            await this.initializeApiHost();
            await this.checkRegisteredStatus();
        });
    }

    /**
     * Initialize API hosts by fetching the discovery URL
     */
    private async initializeApiHost(): Promise<void> {
        const response = await fetch(ENDPOINT_DISCOVERY_URL);
        if (response.status !== 200) {
            throw new Error(`Failed to fetch discovery URL (response code): ${response.status}`);
        }
        
        const data: {
            notifications: string;
            webapp: string;
            mqttbroker: string;
        } = await response.json();

        const auth_host = data.webapp;
        if (!auth_host) {
            throw new Error(`Failed to fetch auth host: ${auth_host}`);
        }
        this.auth_host = `https://${auth_host}`;

        const sync_host = data.notifications;
        if (!sync_host) {
            throw new Error(`Failed to fetch sync host: ${sync_host}`);
        }
        this.sync_host = `https://${sync_host}`;

        console.log("API hosts initialized:", this.auth_host, this.sync_host);
    }

    /**
     * Check if device is registered and has valid access token
     */
    private async checkRegisteredStatus(): Promise<boolean> {
        console.log("Checking registered status...");
        
        // First, check if we have a valid access token
        let access_token = await this.ctx.storage.get("access_token") as string | null;
        if (access_token) {
            // JWT parse the access token, check if it is expired
            try {
                const payload = JSON.parse(atob(access_token.split(".")[1]));
                const exp = payload.exp;
                const now = Math.floor(Date.now() / 1000);
                if (exp > now) {
                    this.access_token = access_token;
                    console.log("Access token is valid");
                    return true;
                } else {
                    console.log("Access token expired");
                }
            } catch (error) {
                console.log("Failed to parse access token:", error);
            }
        }

        console.log("No valid access token found, checking refresh token...");
        
        // If access token is not present or expired, check refresh token
        let refresh_token = await this.ctx.storage.get("refresh_token") as string | null;
        if (refresh_token) {
            // If refresh token is present, use it to get a new access token
            let url = `${this.auth_host}/token/json/2/user/new`;
            let response = await fetch(url, {
                method: "POST",
                headers: {
                    "authorization": `Bearer ${refresh_token}`,
                }
            });
            
            if (response.status === 200) {
                let data = await response.text();
                if (data) {
                    console.log("Refreshed access token");
                    this.access_token = data;
                    // Store the new access token
                    await this.ctx.storage.put("access_token", data);
                    return true;
                } else {
                    console.log("Failed to refresh access token (no data)");
                }
            } else {
                console.log(`Failed to refresh access token (response code): ${response.status}`);
            }
        }

        // If refresh token is not present, we are not registered
        console.log("No refresh token found, not registered");
        this.access_token = null;
        return false;
    }

    /**
     * Register device with reMarkable Connect API
     */
    async register(linkCode: string, deviceId: string): Promise<RegisterResult | AuthError> {
        console.log("Registering device...");

        await this.ctx.storage.put("device_id", deviceId);

        let body = {
            "code": linkCode,
            "deviceDesc": "mobile-android", // We pretend to be a mobile android device
            "deviceID": deviceId,
            "secret": "" // This needs to be an empty string
        };

        let url = `${this.auth_host}/token/json/2/device/new`;

        let response = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
        });

        if (response.status !== 200) {
            const errorText = await response.text();
            console.log("Registration failed. Body:", errorText);
            return {
                success: false,
                error: `Failed to register (response code): ${response.status}`
            };
        }

        let data = await response.text();
        if (!data) {
            return {
                success: false,
                error: "Failed to register (no data)"
            };
        }

        console.log("Registered successfully");
        await this.ctx.storage.put("refresh_token", data);
        
        // Refresh the registered status to get an access token
        if (await this.checkRegisteredStatus()) {
            return {
                success: true,
                device_id: deviceId,
            };
        } else {
            return {
                success: false,
                error: "Failed to register (not registered after token refresh)"
            };
        }
    }

    /**
     * Get current access token, refreshing if necessary
     */
    async getAccessToken(): Promise<string | null> {
        if (this.access_token) {
            // Check if token is still valid
            try {
                const payload = JSON.parse(atob(this.access_token.split(".")[1]));
                const exp = payload.exp;
                const now = Math.floor(Date.now() / 1000);
                if (exp > now) {
                    return this.access_token;
                }
            } catch (error) {
                console.log("Failed to parse access token:", error);
            }
        }

        // Token is expired or invalid, try to refresh
        if (await this.checkRegisteredStatus()) {
            return this.access_token;
        }

        return null;
    }

    /**
     * Check if device is registered
     */
    async isRegistered(): Promise<boolean> {
        const deviceId = await this.ctx.storage.get("device_id") as string | null;
        const refreshToken = await this.ctx.storage.get("refresh_token") as string | null;
        return !!(deviceId && refreshToken);
    }

    /**
     * Get current authentication status
     */
    async getStatus(): Promise<AuthStatus> {
        const registered = await this.isRegistered();
        if (!registered) {
            return { registered: false };
        }

        const deviceId = await this.ctx.storage.get("device_id") as string | null;
        const accessToken = await this.getAccessToken();

        return {
            registered: true,
            device_id: deviceId || undefined,
            access_token_valid: !!accessToken
        };
    }

    /**
     * Destroy the authentication and clear all stored data
     */
    async destroy(): Promise<void> {
        console.log("Destroying AuthDO and clearing all data...");
        
        // Clear all stored data
        await this.ctx.storage.deleteAll();
        
        // Reset in-memory state
        this.access_token = null;
        
        console.log("AuthDO destroyed successfully");
    }
}
