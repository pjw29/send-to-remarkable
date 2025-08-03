// Types for the authentication system

export interface RegisterResult {
    success: true;
    device_id: string;
}

export interface AuthError {
    success: false;
    error: string;
}

export interface AuthStatus {
    registered: boolean;
    device_id?: string;
    access_token_valid?: boolean;
}
