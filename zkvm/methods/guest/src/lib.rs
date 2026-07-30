#![no_std]

extern crate alloc;
#[cfg(test)]
extern crate std;

pub mod sth;
pub mod tally;

#[cfg(test)]
mod compatibility_test;
#[cfg(test)]
mod property_tests;
#[cfg(test)]
mod test_vectors;
