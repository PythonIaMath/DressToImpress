import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import type { Game } from '../lib/types';
import { mediaDevices, MediaStream } from 'react-native-webrtc';

import { streamingSocket } from '../lib/streaming/socketClient';
import { PeerConnectionManager } from '../lib/streaming/peerConnection';

type LiveStreamResult = {
  isPublishing: boolean;
  remoteStream: MediaStream | null;
  remoteStreamUrl: string | null;
  streamOwnerId: string | null;
  startPublishingCamera: () => Promise<void>;
  stopPublishing: () => void;
};

export function useLiveStream(user: User, game: Game): LiveStreamResult {
  const [isPublishing, setIsPublishing] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteStreamUrl, setRemoteStreamUrl] = useState<string | null>(null);
  const [streamOwnerId, setStreamOwnerId] = useState<string | null>(null);

  const peerRef = useRef<PeerConnectionManager | null>(null);
  const peerRoleRef = useRef<'host' | 'viewer' | null>(null);
  const targetRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const cleanupPeer = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    peerRoleRef.current = null;
    targetRef.current = null;
  }, []);

  useEffect(() => {
    const handleStreamStarted = (payload: any) => {
      setStreamOwnerId(payload.userId ?? null);
      if (payload.userId !== user.id) {
        // viewer auto-request connection
        requestViewerConnection(payload.userId);
      } else {
        setIsPublishing(true);
      }
    };

    const handleStreamStopped = () => {
      setStreamOwnerId(null);
      setIsPublishing(false);
      cleanupPeer();
      setRemoteStream(null);
      setRemoteStreamUrl(null);
    };

    const handleSignalingOffer = async (payload: any) => {
      if (!payload || payload.fromUserId === user.id) {
        return;
      }
      const targetUserId = payload.targetUserId;
      if (targetUserId && targetUserId !== user.id) {
        return;
      }
      if (!isPublishing || !localStreamRef.current) {
        return;
      }
      const manager = new PeerConnectionManager('host', user.id, (message) => {
        switch (message.type) {
          case 'answer':
            streamingSocket.sendAnswer({ targetUserId: payload.fromUserId, data: message.data });
            break;
          case 'candidate':
            streamingSocket.sendIceCandidate({
              targetUserId: payload.fromUserId,
              data: message.data,
            });
            break;
          default:
            break;
        }
      });
      manager.attachTrack(localStreamRef.current.getVideoTracks()[0]);
      peerRef.current = manager;
      peerRoleRef.current = 'host';
      targetRef.current = payload.fromUserId;
      await manager.handleOffer(payload.data?.sdp ?? payload.data);
    };

    const handleSignalingAnswer = async (payload: any) => {
      if (!payload || payload.fromUserId === user.id) {
        return;
      }
      const targetUserId = payload.targetUserId;
      if (targetUserId && targetUserId !== user.id) {
        return;
      }
      if (peerRoleRef.current !== 'viewer' || !peerRef.current) {
        return;
      }
      await peerRef.current.handleAnswer(payload.data?.sdp ?? payload.data);
    };

    const handleSignalingIce = async (payload: any) => {
      if (!payload || payload.fromUserId === user.id) {
        return;
      }
      const targetUserId = payload.targetUserId;
      if (targetUserId && targetUserId !== user.id) {
        return;
      }
      if (!peerRef.current) {
        return;
      }
      await peerRef.current.handleCandidate(payload.data?.candidate ?? payload.data);
    };

    streamingSocket.on('stream:started', handleStreamStarted);
    streamingSocket.on('stream:stopped', handleStreamStopped);
    streamingSocket.on('signaling:offer', handleSignalingOffer);
    streamingSocket.on('signaling:answer', handleSignalingAnswer);
    streamingSocket.on('signaling:ice', handleSignalingIce);

    return () => {
      streamingSocket.off('stream:started', handleStreamStarted);
      streamingSocket.off('stream:stopped', handleStreamStopped);
      streamingSocket.off('signaling:offer', handleSignalingOffer);
      streamingSocket.off('signaling:answer', handleSignalingAnswer);
      streamingSocket.off('signaling:ice', handleSignalingIce);
      cleanupPeer();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
      }
    };
  }, [cleanupPeer, isPublishing, user.id]);

  const requestViewerConnection = useCallback(
    async (ownerId: string) => {
      targetRef.current = ownerId;
      const manager = new PeerConnectionManager('viewer', user.id, (message) => {
        switch (message.type) {
          case 'offer':
            streamingSocket.sendOffer({ targetUserId: ownerId, data: message.data });
            break;
          case 'candidate':
            streamingSocket.sendIceCandidate({ targetUserId: ownerId, data: message.data });
            break;
          default:
            break;
        }
      });
      manager.onRemoteTrack((stream) => {
        setRemoteStream(stream);
        setRemoteStreamUrl(stream.toURL());
      });
      peerRef.current = manager;
      peerRoleRef.current = 'viewer';
      await manager.createPeer();
      await manager.createOffer();
    },
    [user.id]
  );

  useEffect(() => {
    if (streamOwnerId && streamOwnerId !== user.id && !remoteStream) {
      void requestViewerConnection(streamOwnerId);
    }
  }, [remoteStream, requestViewerConnection, streamOwnerId, user.id]);

  const startPublishingCamera = useCallback(async () => {
    if (isPublishing) {
      return;
    }
    try {
      const stream = await mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      localStreamRef.current = stream;
      setIsPublishing(true);
      streamingSocket.startStream(undefined, { kind: 'camera' });
    } catch (error) {
      console.warn('[LiveStream] Unable to start camera stream', error);
    }
  }, [isPublishing]);

  const stopPublishing = useCallback(() => {
    if (!isPublishing) {
      return;
    }
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    streamingSocket.stopStream();
    setIsPublishing(false);
    cleanupPeer();
  }, [cleanupPeer, isPublishing]);

  return useMemo(
    () => ({
      isPublishing,
      remoteStream,
      remoteStreamUrl,
      streamOwnerId,
      startPublishingCamera,
      stopPublishing,
    }),
    [isPublishing, remoteStream, remoteStreamUrl, streamOwnerId, startPublishingCamera, stopPublishing]
  );
}
