import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  MediaStream,
  MediaStreamTrack,
} from 'react-native-webrtc';

type PeerRole = 'host' | 'viewer';

type SignalingHandlerPayload =
  | { type: 'offer'; data: RTCSessionDescriptionInit }
  | { type: 'answer'; data: RTCSessionDescriptionInit }
  | { type: 'candidate'; data: RTCIceCandidateInit };

type SignalingHandler = (payload: SignalingHandlerPayload) => void;

type TrackListener = (stream: MediaStream) => void;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class PeerConnectionManager {
  private peer: RTCPeerConnection | null = null;
  private remoteStream: MediaStream | null = null;
  private localTrack: MediaStreamTrack | null = null;
  private readonly role: PeerRole;
  private readonly userId: string;
  private signalingHandler: SignalingHandler;
  private trackListener?: TrackListener;

  constructor(role: PeerRole, userId: string, signalingHandler: SignalingHandler) {
    this.role = role;
    this.userId = userId;
    this.signalingHandler = signalingHandler;
  }

  attachTrack(track: MediaStreamTrack) {
    this.localTrack = track;
    if (this.peer && track) {
      const stream = new MediaStream([track]);
      stream.getTracks().forEach((t) => this.peer?.addTrack(t, stream));
    }
  }

  async createPeer() {
    if (this.peer) {
      return this.peer;
    }
    this.peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.peer.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingHandler({
          type: 'candidate',
          data: event.candidate.toJSON(),
        });
      }
    };

    this.peer.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.remoteStream = event.streams[0];
        if (this.trackListener) {
          this.trackListener(event.streams[0]);
        }
      }
    };

    if (this.localTrack) {
      const stream = new MediaStream([this.localTrack]);
      stream.getTracks().forEach((track) => this.peer?.addTrack(track, stream));
    }

    return this.peer;
  }

  onRemoteTrack(listener: TrackListener) {
    this.trackListener = listener;
    if (this.remoteStream) {
      listener(this.remoteStream);
    }
  }

  async handleOffer(offer: RTCSessionDescriptionInit) {
    const peer = await this.createPeer();
    await peer.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);

    this.signalingHandler({ type: 'answer', data: answer });
  }

  async handleAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.peer) {
      return;
    }
    await this.peer.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async handleCandidate(candidate: RTCIceCandidateInit) {
    if (!this.peer) {
      return;
    }
    try {
      await this.peer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.warn('[PeerConnection] failed to add candidate', error);
    }
  }

  async createOffer() {
    const peer = await this.createPeer();
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    this.signalingHandler({ type: 'offer', data: offer });
  }

  close() {
    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }
    this.remoteStream = null;
  }
}
