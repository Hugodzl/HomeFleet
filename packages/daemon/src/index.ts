/**
 * homefleetd — the HomeFleet per-machine daemon.
 *
 * M2 surface: device identity, trust store, mTLS transport with fingerprint
 * pinning, and the pairing-code flow. M3 adds LAN discovery (mDNS + UDP
 * multicast + static entries, merged by the aggregator) and the daemon
 * config file. Job dispatch (M5) builds on these.
 */
export { type CliDeps, type CliIdentity, runCli } from "./cli/cli.js";
export {
  ControlClient,
  type ControlClientLike,
  type ControlClientOptions,
  ControlRequestError,
  DaemonUnreachableError,
  type PairBeginResult,
  type PairConnectInput,
} from "./cli/control-client.js";
export {
  type AutostartCreateOptions,
  type AutostartRemoveOptions,
  DEFAULT_AUTOSTART_TASK_NAME,
  DEFAULT_RULE_NAME_PREFIX,
  type FirewallPortOptions,
  type FirewallRemoveOptions,
  type FirewallRuleKind,
  firewallRuleName,
  generateAutostartCreateCommand,
  generateAutostartRemoveCommand,
  generateFirewallAllowCommands,
  generateFirewallRemoveCommands,
  PUBLIC_PROFILE_WARNING,
  publicProfileCheckCommand,
} from "./cli/setup-commands.js";
export {
  type AgentExecutorConfig,
  AgentExecutorConfigSchema,
  type CatalogConfig,
  CatalogConfigSchema,
  type CatalogEndpointConfig,
  CatalogEndpointConfigSchema,
  type CatalogModelConfig,
  CatalogModelConfigSchema,
  type CommandAllowlistEntryConfig,
  CommandAllowlistEntryConfigSchema,
  type CommandExecutorConfig,
  CommandExecutorConfigSchema,
  type ControlConfig,
  ControlConfigSchema,
  type DaemonConfig,
  DaemonConfigSchema,
  DEFAULT_CONTROL_PORT,
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MAX_CACHED_CHECKOUTS,
  DEFAULT_MCP_PORT,
  DEFAULT_WORKSPACE_GC_AFTER_FETCHES,
  DEFAULT_WORKSPACE_GIT_TIMEOUT_MS,
  type DiscoveryConfig,
  DiscoveryConfigSchema,
  type ExecutorsConfig,
  ExecutorsConfigSchema,
  type HfpConfig,
  HfpConfigSchema,
  type JobsConfig,
  JobsConfigSchema,
  loadDaemonConfig,
  type McpConfig,
  McpConfigSchema,
  type NodeConfig,
  NodeConfigSchema,
  type RepoMapping,
  RepoMappingSchema,
  type StaticNode,
  StaticNodeSchema,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
} from "./config/config.js";
export { resolveDataDir } from "./config/paths.js";
export {
  CONTROL_HEADER,
  type ControlServerOptions,
  type ControlStatus,
  type ControlSurface,
  MAX_CONTROL_REQUEST_BYTES,
  type PairConnectSummary,
  type RunningControlServer,
  startControlServer,
} from "./control/control-server.js";
export {
  type PairConnectRequest,
  PairConnectRequestSchema,
} from "./control/messages.js";
export { DAEMON_VERSION, Daemon, type DaemonOptions } from "./daemon.js";
export {
  DiscoveryAggregator,
  type DiscoveryAggregatorOptions,
  LAST_SEEN_PERSIST_THRESHOLD_MS,
} from "./discovery/aggregator.js";
export type {
  DiscoveryCandidate,
  DiscoverySource,
} from "./discovery/candidate.js";
export {
  type KnownNode,
  KnownNodeSchema,
  KnownNodesRegistry,
  MAX_KNOWN_NODES,
} from "./discovery/known-nodes.js";
export type {
  MdnsBackend,
  MdnsBrowser,
  MdnsFoundService,
  MdnsPublication,
  MdnsPublishRequest,
} from "./discovery/mdns.js";
export type { UdpSendTarget } from "./discovery/udp.js";
export { certFingerprint } from "./identity/fingerprint.js";
export { type Identity, loadOrCreateIdentity } from "./identity/identity.js";
export {
  JobDispatchError,
  type JobRecord,
  type JobSubscriber,
} from "./jobs/job.js";
export {
  DEFAULT_CANCEL_UNWIND_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_MAX_QUEUED_JOBS,
  DEFAULT_MAX_RETAINED_JOBS,
  JobManager,
  type JobManagerOptions,
  type JobSubscription,
  type WorkspaceHandle,
  type WorkspaceResolver,
} from "./jobs/job-manager.js";
export {
  registerJobRoutes,
  SSE_HEARTBEAT_MS,
  statusForCode,
} from "./jobs/routes.js";
export {
  DelegationRegistry,
  type DelegationRoute,
  MAX_TRACKED_DELEGATIONS,
} from "./mcp/delegation-registry.js";
export {
  LOOPBACK_HOSTS,
  MAX_MCP_REQUEST_BYTES,
  type McpHttpServerOptions,
  type RunningMcpHttpServer,
  startMcpHttpServer,
} from "./mcp/http-transport.js";
export {
  DEFAULT_HELLO_TIMEOUT_MS,
  endpointSourceFromDiscovery,
  NodeDirectory,
  type NodeDirectoryEntry,
  type NodeDirectoryOptions,
  type NodeEndpoint,
  type NodeEndpointSource,
  type ResolvedNode,
} from "./mcp/node-directory.js";
export { createRepoResolver } from "./mcp/repo-resolver.js";
export {
  createMcpServer,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
} from "./mcp/server.js";
export {
  type ArtifactStatus,
  ArtifactStatusSchema,
  DelegateTaskOutputSchema,
  type DelegationClient,
  JobResultOutputSchema,
  JobStatusOutputSchema,
  ListNodesOutputSchema,
  type McpToolCollaborators,
  type NodeSummary,
  NodeSummarySchema,
  type RepoResolver,
  registerHomeFleetTools,
  type WorkspaceSyncClient,
} from "./mcp/tools.js";
export {
  createNodeInfoProvider,
  currentPlatform,
  type JobLoadSource,
  type NodeInfoConfig,
  type NodeInfoProviderOptions,
} from "./node/node-info.js";
export {
  DEFAULT_PAIRING_TTL_MS,
  generatePairingCode,
  MAX_PAIRING_FAILURES,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairingManager,
  type PairingManagerOptions,
} from "./pairing/pairing.js";
export {
  ArtifactHeadCommitError,
  BUNDLE_UPLOAD_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FingerprintMismatchError,
  HfpClient,
  HfpRequestError,
  type HfpRequestOptions,
  HfpResponseTooLargeError,
  type HfpTarget,
  HfpTimeoutError,
  MAX_SSE_EVENT_BYTES,
  MAX_SSE_TOTAL_BYTES,
  MissingServerCertificateError,
  type PairTarget,
  STREAM_IDLE_TIMEOUT_MS,
} from "./transport/client.js";
export { HEAD_COMMIT_HEADER, REPO_ID_HEADER } from "./transport/headers.js";
export { MAX_BODY_BYTES } from "./transport/limits.js";
export {
  NodeServer,
  type NodeServerOptions,
  type PeerInfo,
  type RouteAuth,
  type RouteContext,
  type RouteHandler,
  type RouteOptions,
  type RouteResult,
  type StreamRouteContext,
  type StreamRouteHandler,
  type StreamRouteOptions,
  type UploadRouteContext,
  type UploadRouteHandler,
  type UploadRouteOptions,
} from "./transport/server.js";
export {
  type TrustedDevice,
  TrustedDeviceSchema,
  TrustStore,
} from "./trust/trust-store.js";
export {
  COMMIT_HASH_RE,
  type CreateBundleOptions,
  createBundle,
  DEFAULT_GIT_TIMEOUT_MS,
  GitError,
  isAncestor,
  resolveHeadCommit,
} from "./workspace/git.js";
export { registerWorkspaceRoutes } from "./workspace/routes.js";
export {
  repoKey,
  WorkspaceError,
  type WorkspaceErrorCode,
  WorkspaceStore,
  type WorkspaceStoreOptions,
} from "./workspace/workspace-store.js";
