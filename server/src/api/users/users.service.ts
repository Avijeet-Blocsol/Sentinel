/**
 * Strands Sentinel - Users Service
 * Encapsulates user profile queries and device registration logic.
 */

import { randomUUID } from 'node:crypto';
import { userDeviceRepository, type UserDevice } from '../../db/index.js';
import type { RegisterDeviceBody } from './users.schema.js';

export class UsersService {
  async registerDevice(userId: string, data: RegisterDeviceBody): Promise<UserDevice> {
    const existingDevices = await userDeviceRepository.getByUserId(userId);
    const existing = existingDevices.find((candidate) => candidate.push_token === data.push_token);

    const device: UserDevice = {
      id: existing?.id || randomUUID(),
      user_id: userId,
      push_token: data.push_token,
      platform: data.platform,
      last_active_at: Date.now(),
    };

    await userDeviceRepository.registerDevice(device);
    return device;
  }

  async getDevices(userId: string): Promise<UserDevice[]> {
    return userDeviceRepository.getByUserId(userId);
  }
}

export const usersService = new UsersService();
