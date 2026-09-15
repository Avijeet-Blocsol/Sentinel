/**
 * Strands Sentinel - S3 Session Storage Adapter
 * Provides storage backend for Strands SDK SessionManager.
 * Uses Amazon S3 for cloud environments, with seamless LocalFileStorage fallback for local development.
 */

import { S3Storage, LocalFileStorage, type Storage } from '@strands-agents/sdk/storage';
import { S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';
import path from 'node:path';
import { usesAwsInfrastructure } from '../../config/infrastructure_mode.js';

export interface SessionStorageConfig {
  bucket?: string;
  prefix?: string;
  region?: string;
}

export function getSessionStorage(config?: SessionStorageConfig): Storage {
  const awsInfrastructure = usesAwsInfrastructure();
  const bucket = awsInfrastructure
    ? config?.bucket || process.env.AWS_S3_SESSION_BUCKET
    : undefined;
  const prefix = config?.prefix || process.env.AWS_S3_SESSION_PREFIX || 'sentinel/sessions/';
  const region = config?.region || process.env.AWS_REGION || 'us-east-1';

  if (awsInfrastructure && process.env.NODE_ENV === 'production' && !bucket) {
    throw new Error('Production requires AWS_S3_SESSION_BUCKET; refusing local session storage fallback');
  }

  if (bucket) {
    const client = new S3Client({ region });
    const encryption = process.env.AWS_S3_SERVER_SIDE_ENCRYPTION || 'AES256';
    const kmsKeyId = process.env.AWS_S3_KMS_KEY_ID;
    client.middlewareStack.add(
      (next) => async (args) => {
        const input = args.input as PutObjectCommandInput;
        if (input.Body && !input.ServerSideEncryption) {
          input.ServerSideEncryption = encryption as PutObjectCommandInput['ServerSideEncryption'];
          if (encryption === 'aws:kms' && kmsKeyId) input.SSEKMSKeyId = kmsKeyId;
        }
        return next(args);
      },
      { step: 'build', name: 'sentinel-session-sse', priority: 'high' },
    );
    return new S3Storage(bucket, { prefix, s3Client: client });
  }

  // Graceful fallback for local offline development without AWS bucket
  const localDir = process.env.STRANDS_LOCAL_STORAGE_DIR || path.resolve(process.cwd(), '.strands');
  return new LocalFileStorage(localDir);
}
