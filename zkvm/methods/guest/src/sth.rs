/// STH (Signed Tree Head) digest calculation for split-view attack prevention
/// Following final-design.md §2.4 specifications
use risc0_zkvm::sha::{Impl, Sha256};

/// Compute STH digest for split-view attack prevention
/// SHA256(logId || treeSize || timestamp || bulletinRoot)
///
/// Parameters:
/// - log_id: 32-byte bulletin board identifier
/// - tree_size: Tree size (u32, little-endian)
/// - timestamp: Unix timestamp in milliseconds (u64, little-endian)
/// - bulletin_root: 32-byte Merkle root
pub fn compute_sth_digest(
    log_id: &[u8; 32],
    tree_size: u32,
    timestamp: u64,
    bulletin_root: &[u8; 32],
) -> [u8; 32] {
    // Build the data to hash: log_id || tree_size || timestamp || bulletin_root
    // Total: 32 + 4 + 8 + 32 = 76 bytes
    let mut data = [0u8; 76];

    // Copy log ID (32 bytes)
    data[0..32].copy_from_slice(log_id);

    // Copy tree size (4 bytes, little-endian)
    data[32..36].copy_from_slice(&tree_size.to_le_bytes());

    // Copy timestamp (8 bytes, little-endian)
    data[36..44].copy_from_slice(&timestamp.to_le_bytes());

    // Copy bulletin root (32 bytes)
    data[44..76].copy_from_slice(bulletin_root);

    // Hash the concatenated data
    let digest = Impl::hash_bytes(&data);

    // Convert to fixed-size array
    let mut result = [0u8; 32];
    result.copy_from_slice(digest.as_bytes());
    result
}
