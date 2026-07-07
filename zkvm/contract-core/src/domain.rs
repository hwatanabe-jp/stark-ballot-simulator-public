use alloc::vec;
use alloc::vec::Vec;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ElectionId16([u8; 16]);

macro_rules! hash32_domain_type {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
        pub struct $name([u8; 32]);

        impl $name {
            pub fn new(value: [u8; 32]) -> Self {
                Self(value)
            }

            pub fn from_slice(value: &[u8]) -> Result<Self, DomainValidationError> {
                if value.len() != 32 {
                    return Err(DomainValidationError::InvalidByteLength {
                        field: stringify!($name),
                        actual: value.len(),
                        expected: 32,
                    });
                }

                let mut bytes = [0u8; 32];
                bytes.copy_from_slice(value);
                Ok(Self(bytes))
            }

            pub fn get(self) -> [u8; 32] {
                self.0
            }

            pub fn as_bytes(&self) -> &[u8; 32] {
                &self.0
            }
        }
    };
}

hash32_domain_type!(VoteCommitment);
hash32_domain_type!(Randomness32);
hash32_domain_type!(SeenBitmapRoot);
hash32_domain_type!(IncludedBitmapRoot);
hash32_domain_type!(InputCommitment);
hash32_domain_type!(ElectionConfigHash);
hash32_domain_type!(LogId);
hash32_domain_type!(SthDigest);
hash32_domain_type!(MerkleNodeHash);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BulletinRoot([u8; 32]);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TreeSize(u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TotalExpected(u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VoteCount(u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BulletinIndex(u32);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BitmapBitIndex(usize);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BitmapLeafIndex(usize);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BitmapBitOffset(usize);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnixTimestampMillis(u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DomainValidationError {
    EmptyTree,
    NonPositiveTimestamp,
    IndexOutOfRange {
        index: u32,
        tree_size: u32,
    },
    BitmapIndexOutOfRange {
        index: usize,
        bit_len: usize,
    },
    AuditPathLengthMismatch {
        actual: usize,
        expected: usize,
    },
    InvalidByteLength {
        field: &'static str,
        actual: usize,
        expected: usize,
    },
    ZeroHash {
        field: &'static str,
    },
    CountOverflow {
        field: &'static str,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ValidatedAuditPath<'a> {
    tree_size: TreeSize,
    leaf_index: BulletinIndex,
    nodes: &'a [[u8; 32]],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PackedBitmap {
    bits_len: usize,
    bytes: Vec<u8>,
}

impl ElectionId16 {
    pub fn new(value: [u8; 16]) -> Self {
        Self(value)
    }

    pub fn from_slice(value: &[u8]) -> Result<Self, DomainValidationError> {
        if value.len() != 16 {
            return Err(DomainValidationError::InvalidByteLength {
                field: "ElectionId16",
                actual: value.len(),
                expected: 16,
            });
        }

        let mut bytes = [0u8; 16];
        bytes.copy_from_slice(value);
        Ok(Self(bytes))
    }

    pub fn get(self) -> [u8; 16] {
        self.0
    }

    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

impl BulletinRoot {
    pub fn new(value: [u8; 32]) -> Result<Self, DomainValidationError> {
        if value.iter().all(|&byte| byte == 0) {
            return Err(DomainValidationError::ZeroHash {
                field: "BulletinRoot",
            });
        }

        Ok(Self(value))
    }

    pub fn from_slice(value: &[u8]) -> Result<Self, DomainValidationError> {
        if value.len() != 32 {
            return Err(DomainValidationError::InvalidByteLength {
                field: "BulletinRoot",
                actual: value.len(),
                expected: 32,
            });
        }

        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(value);
        Self::new(bytes)
    }

    pub fn get(self) -> [u8; 32] {
        self.0
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl TreeSize {
    pub fn new(value: u32) -> Result<Self, DomainValidationError> {
        if value == 0 {
            return Err(DomainValidationError::EmptyTree);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl TotalExpected {
    pub fn new(value: u32) -> Self {
        Self(value)
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl VoteCount {
    pub fn new(value: usize) -> Result<Self, DomainValidationError> {
        let count = u32::try_from(value)
            .map_err(|_| DomainValidationError::CountOverflow { field: "VoteCount" })?;

        Ok(Self(count))
    }

    pub fn from_u32(value: u32) -> Self {
        Self(value)
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl BulletinIndex {
    pub fn new(value: u32, tree_size: TreeSize) -> Result<Self, DomainValidationError> {
        if value >= tree_size.get() {
            return Err(DomainValidationError::IndexOutOfRange {
                index: value,
                tree_size: tree_size.get(),
            });
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u32 {
        self.0
    }
}

impl BitmapBitIndex {
    pub fn new(value: usize, bit_len: usize) -> Result<Self, DomainValidationError> {
        if value >= bit_len {
            return Err(DomainValidationError::BitmapIndexOutOfRange {
                index: value,
                bit_len,
            });
        }

        Ok(Self(value))
    }

    pub fn get(self) -> usize {
        self.0
    }
}

impl BitmapLeafIndex {
    pub fn from_bit_index(bit_index: BitmapBitIndex) -> Self {
        Self(bit_index.get() / 256)
    }

    pub fn get(self) -> usize {
        self.0
    }
}

impl BitmapBitOffset {
    pub fn from_bit_index(bit_index: BitmapBitIndex) -> Self {
        Self(bit_index.get() % 256)
    }

    pub fn get(self) -> usize {
        self.0
    }
}

impl UnixTimestampMillis {
    pub fn new(value: u64) -> Result<Self, DomainValidationError> {
        if value == 0 {
            return Err(DomainValidationError::NonPositiveTimestamp);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl PackedBitmap {
    pub fn from_bits(bits: &[bool]) -> Self {
        let byte_len = bits.len().div_ceil(8);
        let mut bytes = vec![0u8; byte_len];

        for (chunk_index, chunk) in bits.chunks(8).enumerate() {
            let mut byte = 0u8;
            for (bit_index, bit) in chunk.iter().enumerate() {
                if *bit {
                    byte |= 1 << bit_index;
                }
            }
            bytes[chunk_index] = byte;
        }

        Self {
            bits_len: bits.len(),
            bytes,
        }
    }

    pub fn bit_len(&self) -> usize {
        self.bits_len
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl<'a> ValidatedAuditPath<'a> {
    pub fn validate(
        tree_size: TreeSize,
        leaf_index: BulletinIndex,
        nodes: &'a [[u8; 32]],
    ) -> Result<Self, DomainValidationError> {
        let expected = expected_rfc6962_audit_path_len(tree_size, leaf_index);
        if nodes.len() != expected {
            return Err(DomainValidationError::AuditPathLengthMismatch {
                actual: nodes.len(),
                expected,
            });
        }

        Ok(Self {
            tree_size,
            leaf_index,
            nodes,
        })
    }

    pub fn tree_size(self) -> TreeSize {
        self.tree_size
    }

    pub fn leaf_index(self) -> BulletinIndex {
        self.leaf_index
    }

    pub fn nodes(self) -> &'a [[u8; 32]] {
        self.nodes
    }
}

fn expected_rfc6962_audit_path_len(tree_size: TreeSize, leaf_index: BulletinIndex) -> usize {
    let mut index = leaf_index.get();
    let mut level_size = tree_size.get();
    let mut expected = 0usize;

    while level_size > 1 {
        if index % 2 == 1 || index + 1 < level_size {
            expected += 1;
        }
        index /= 2;
        level_size = level_size.div_ceil(2);
    }

    expected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_tree() {
        assert_eq!(TreeSize::new(0), Err(DomainValidationError::EmptyTree));
    }

    #[test]
    fn rejects_invalid_byte_lengths_at_domain_boundary() {
        assert_eq!(
            VoteCommitment::from_slice(&[1u8; 31]),
            Err(DomainValidationError::InvalidByteLength {
                field: "VoteCommitment",
                actual: 31,
                expected: 32
            })
        );
        assert_eq!(
            ElectionId16::from_slice(&[1u8; 15]),
            Err(DomainValidationError::InvalidByteLength {
                field: "ElectionId16",
                actual: 15,
                expected: 16
            })
        );
    }

    #[test]
    fn rejects_zero_bulletin_root() {
        assert_eq!(
            BulletinRoot::new([0u8; 32]),
            Err(DomainValidationError::ZeroHash {
                field: "BulletinRoot"
            })
        );
    }

    #[test]
    fn rejects_non_positive_unix_timestamp_millis() {
        assert_eq!(
            UnixTimestampMillis::new(0),
            Err(DomainValidationError::NonPositiveTimestamp)
        );
    }

    #[test]
    fn binds_bulletin_index_to_tree_size() {
        let tree_size = TreeSize::new(2).unwrap();

        assert_eq!(BulletinIndex::new(1, tree_size).unwrap().get(), 1);
        assert_eq!(
            BulletinIndex::new(2, tree_size),
            Err(DomainValidationError::IndexOutOfRange {
                index: 2,
                tree_size: 2
            })
        );
    }

    #[test]
    fn binds_bitmap_indices_to_bitmap_length() {
        let bit_index = BitmapBitIndex::new(256, 257).unwrap();

        assert_eq!(bit_index.get(), 256);
        assert_eq!(BitmapLeafIndex::from_bit_index(bit_index).get(), 1);
        assert_eq!(BitmapBitOffset::from_bit_index(bit_index).get(), 0);
        assert_eq!(
            BitmapBitIndex::new(257, 257),
            Err(DomainValidationError::BitmapIndexOutOfRange {
                index: 257,
                bit_len: 257
            })
        );
    }

    #[test]
    fn packs_bitmap_bits_lsb_first() {
        let packed =
            PackedBitmap::from_bits(&[true, false, true, false, false, false, false, false, true]);

        assert_eq!(packed.bit_len(), 9);
        assert_eq!(packed.bytes(), &[0x05, 0x01]);
    }

    #[test]
    fn validates_promoted_audit_path_shape() {
        let tree_size = TreeSize::new(3).unwrap();
        let index = BulletinIndex::new(2, tree_size).unwrap();

        assert!(ValidatedAuditPath::validate(tree_size, index, &[[0u8; 32]]).is_ok());
        assert_eq!(
            ValidatedAuditPath::validate(tree_size, index, &[]),
            Err(DomainValidationError::AuditPathLengthMismatch {
                actual: 0,
                expected: 1
            })
        );
    }

    #[test]
    fn validates_sibling_audit_path_shape() {
        let tree_size = TreeSize::new(3).unwrap();
        let index = BulletinIndex::new(0, tree_size).unwrap();

        assert!(ValidatedAuditPath::validate(tree_size, index, &[[0u8; 32]; 2]).is_ok());
        assert_eq!(
            ValidatedAuditPath::validate(tree_size, index, &[[0u8; 32]]),
            Err(DomainValidationError::AuditPathLengthMismatch {
                actual: 1,
                expected: 2
            })
        );
    }
}
