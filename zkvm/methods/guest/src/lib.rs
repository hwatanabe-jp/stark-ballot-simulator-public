#![no_std]

extern crate alloc;
#[cfg(test)]
extern crate std;

pub mod sth;
pub mod tally;

#[cfg(test)]
mod cross_language_vectors_test;
#[cfg(test)]
mod property_tests;
