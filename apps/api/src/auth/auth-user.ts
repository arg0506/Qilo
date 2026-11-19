export interface AuthUser {
  id: string;
  authSubject: string;
  isGuest: boolean;
  displayName: string;
  avatarUrl: string | null;
  role: "user" | "admin";
  canHost: boolean;
}
