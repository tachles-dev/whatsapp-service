export type ModuleName =
  | 'admin'
  | 'audit'
  | 'heartbeat'
  | 'webhooks'
  | 'scheduling'
  | 'multiInstanceLeasing'
  | 'ownerForwarding';

export interface ModuleFlags {
  admin: boolean;
  audit: boolean;
  heartbeat: boolean;
  webhooks: boolean;
  scheduling: boolean;
  multiInstanceLeasing: boolean;
  ownerForwarding: boolean;
}

export type ModuleProfileName = 'lite' | 'standard' | 'full';

export const DEFAULT_MODULES: ModuleFlags = {
  admin: true,
  audit: true,
  heartbeat: true,
  webhooks: true,
  scheduling: true,
  multiInstanceLeasing: true,
  ownerForwarding: true,
};

export const MODULE_PROFILES: Record<ModuleProfileName, ModuleFlags> = {
  lite: {
    admin: false,
    audit: false,
    heartbeat: false,
    webhooks: true,
    scheduling: false,
    multiInstanceLeasing: false,
    ownerForwarding: false,
  },
  standard: {
    admin: true,
    audit: true,
    heartbeat: true,
    webhooks: true,
    scheduling: true,
    multiInstanceLeasing: false,
    ownerForwarding: false,
  },
  full: {
    admin: true,
    audit: true,
    heartbeat: true,
    webhooks: true,
    scheduling: true,
    multiInstanceLeasing: true,
    ownerForwarding: true,
  },
};