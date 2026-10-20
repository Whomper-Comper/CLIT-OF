import type { Client } from "discord.js";
import type { BotDatabase } from "../db.js";
import type { OpenFrontApi } from "../api.js";
import { CommunityService } from "./service.js";
import { registerEventWork } from "./eventDelivery.js";
import { registerMilestoneWork } from "./milestoneWorker.js";
import { registerBingoWork } from './bingoWorker.js';
import { registerDuelWork } from './duelWorker.js';

/** Feature modules register their tasks and delivery handlers here as they are added. */
export function createCommunityService(client: Client, db: BotDatabase, api: OpenFrontApi): CommunityService {
  const service=new CommunityService(client,db,api);
  registerEventWork(service,client,db);
  registerMilestoneWork(service,client,db,api);
  registerBingoWork(service,client,db);
  registerDuelWork(service,client,db);
  return service;
}
