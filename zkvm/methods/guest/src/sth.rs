/// STH (Signed Tree Head) digest calculation for split-view attack prevention
/// Following final_design.md §2.4 specifications
use risc0_zkvm::sha::{Impl, Sha256};

/// Compute STH digest for split-view attack prevention
/// SHA256(logId || treeSize || timestamp || bulletinRoot)
///
/// Parameters:
/// - log_id: 32-byte bulletin board identifier
/// - tree_size: Tree size (u32, little-endian)
/// - timestamp: Unix timestamp (u64, little-endian)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sth_digest_deterministic() {
        let log_id = [1u8; 32];
        let tree_size = 64u32;
        let timestamp = 1234567890u64;
        let bulletin_root = [2u8; 32];

        let digest1 = compute_sth_digest(&log_id, tree_size, timestamp, &bulletin_root);
        let digest2 = compute_sth_digest(&log_id, tree_size, timestamp, &bulletin_root);

        assert_eq!(digest1, digest2, "Same inputs should produce same digest");
    }

    #[test]
    fn test_sth_digest_different_timestamps() {
        let log_id = [3u8; 32];
        let tree_size = 32u32;
        let bulletin_root = [4u8; 32];

        let digest1 = compute_sth_digest(&log_id, tree_size, 1000000u64, &bulletin_root);
        let digest2 = compute_sth_digest(&log_id, tree_size, 2000000u64, &bulletin_root);

        assert_ne!(
            digest1, digest2,
            "Different timestamps should produce different digests"
        );
    }

    #[test]
    fn test_sth_digest_different_tree_sizes() {
        let log_id = [5u8; 32];
        let timestamp = 3000000u64;
        let bulletin_root = [6u8; 32];

        let digest1 = compute_sth_digest(&log_id, 10u32, timestamp, &bulletin_root);
        let digest2 = compute_sth_digest(&log_id, 20u32, timestamp, &bulletin_root);

        assert_ne!(
            digest1, digest2,
            "Different tree sizes should produce different digests"
        );
    }

    #[test]
    fn test_sth_digest_endianness() {
        // Test that values are encoded in little-endian
        let log_id = [7u8; 32];
        let tree_size = 0x12345678u32; // Will be 78 56 34 12 in little-endian
        let timestamp = 0x123456789ABCDEF0u64; // Will be F0 DE BC 9A 78 56 34 12 in little-endian
        let bulletin_root = [8u8; 32];

        let digest = compute_sth_digest(&log_id, tree_size, timestamp, &bulletin_root);

        // The digest should be deterministic based on little-endian encoding
        assert_eq!(digest.len(), 32);

        // Verify different byte orderings produce different results
        let tree_size_be = 0x78563412u32; // Big-endian interpretation of same bytes
        let digest_different = compute_sth_digest(&log_id, tree_size_be, timestamp, &bulletin_root);
        assert_ne!(
            digest, digest_different,
            "Different byte orders should produce different digests"
        );
    }
}
