export interface Device {
  id: string;
  name: string;
  approved: boolean;
  connected: boolean;
  handRaised?: boolean;
  canDraw?: boolean;
}

export interface SharedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  uploadedAt: number;
}

export interface ChatMessage {
  id: string;
  name: string;
  text: string;
  t: number;
}

export interface Point {
  x: number; // Normalized [0, 1] relative to video videoWidth/videoHeight
  y: number; // Normalized [0, 1] relative to video videoWidth/videoHeight
}

export interface DoodleStroke {
  id: string;
  name?: string;
  points: Point[];
  color: string;
  lineWidth: number;
  phase: 'start' | 'draw' | 'end';
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnCredentialsResponse {
  enabled: boolean;
  iceServers: IceServerConfig[];
}

export interface AppConfig {
  localIP: string;
  port: number;
  tvUrl: string;
  senderUrl: string;
}
