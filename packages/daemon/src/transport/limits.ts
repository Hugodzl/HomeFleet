/**
 * Transport-wide limits shared by the HFP server and client.
 */

/**
 * Maximum accepted JSON body size, on both sides: the server caps request
 * bodies (413), the client caps buffered response bodies.
 */
export const MAX_BODY_BYTES = 1024 * 1024;
