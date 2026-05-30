import type { ja } from './ja';
import type { TranslationShape } from '../types';

export const en = {
  common: {
    start: 'Start',
    loading: 'Loading...',
    unknown: 'Unknown',
  },
  pages: {
    home: {
      welcome: 'Welcome to STARK Ballot Simulator',
      description: 'Educational demo of verifiable voting with STARK proofs',
    },
    vote: {
      title: 'Vote',
      overview:
        'Select your preferred option from the choices below. Your vote will be encrypted and added to the voting pool.',
      selectionTitle: 'Select your choice',
      selectionLabel: 'Vote selection',
      optionLabel: 'Option {{option}}',
      submit: 'Cast Vote',
      submitting: 'Submitting...',
      errors: {
        sessionNotFound: 'Session not found',
        sessionReplaced: 'This session was replaced in another tab. Please restart from the home page.',
      },
      botVoting: {
        title: '63 bots are voting',
        processing: 'Processing...',
      },
    },
    aggregate: {
      title: 'Aggregate',
      description: 'Select aggregation options.',
      execute: 'Start Aggregation',
      executing: 'Aggregating...',
      scenarios: {
        title: 'Select tampering scenario',
        cardTitle: 'Tampering Scenario',
        description: 'Choose one option to start aggregation',
      },
      progress: {
        title: {
          processing: 'Processing',
          completed: 'Completed',
        },
        description: {
          completed: 'Moving to results',
          processing: 'Finalization takes about 5 minutes',
        },
        phase: {
          waiting: 'Waiting in queue',
          processing: 'Processing',
          completed: 'Completed',
          error: 'Error',
          timeout: 'Timeout',
        },
        queue: {
          waiting: 'Waiting',
          position: 'Queue Position',
          estStart: 'Est. Start',
          estCompletion: 'Est. Completion',
        },
        estimate: {
          soon: 'Soon',
          takingLonger: 'Taking longer...',
          approxSeconds: '~{{seconds}}s',
          approxMinutes: '~{{minutes}} min',
          estCompletionLabel: 'Est. completion: ',
        },
      },
      errors: {
        sessionNotFound: 'Session not found',
        sessionReplaced: 'This session was replaced in another tab. Please restart from the home page.',
        scenarioRequired: 'Select a tampering scenario',
        timeout: 'Request timed out',
      },
    },
    result: {
      title: 'Aggregation Result',
      description: 'zkVM aggregation is complete.',
      loading: 'Loading...',
      errors: {
        sessionNotFound: 'Session not found',
        sessionReplaced: 'This session was replaced in another tab. Please restart from the home page.',
        noResult: 'No aggregation result found',
      },
      tally: {
        title: 'Voting Results',
        totalVotes: 'Total {{total}} votes',
      },
      noticeNotVerified: 'These results have not been verified yet',
      startVerification: 'Cryptographically verify the results',
    },
    verify: {
      title: 'Verify',
      subtitle: 'Review the verification results and download the proof bundle for independent audit',
      loading: 'Loading verification results...',
      sessionError: 'No session found. Please complete the voting process first.',
      sessionReplaced: 'This session was replaced in another tab. Please restart from the home page.',
      directAccess: 'Verification must be started from the aggregation result page.',
      failed: 'Verification Failed',
      actions: {
        backToResult: 'Back to results',
      },
      status: {
        partial: 'Verification partially completed',
        timeout: 'STARK verification timed out',
      },
      stepsCard: {
        preparing: 'Preparing verification...',
        footnoteStarkLast: 'Note: STARK verification runs last',
        footnoteClickable: 'Click an item to highlight related knowledge.',
        evidence: {
          local: 'Local',
          public: 'Public',
          zk: 'ZK',
          demo: 'Demo',
        },
        status: {
          pending: 'Pending',
          running: 'Running',
          success: 'Passed',
          failed: 'Failed',
        },
        errors: {
          generic: 'An error occurred during verification. Please try again later.',
        },
        notes: {
          myVoteIncluded: {
            excluded: 'The tally reports excluded records, so individual inclusion proof is unavailable.',
            notPresented: 'Your index was not presented to the prover in the final tally input.',
            presentedButInvalid: 'Your index was presented to the prover, but it failed validation and was excluded.',
            proofUnavailable: 'Bitmap proof materials are unavailable in this deployment.',
            missingReceipt: 'Vote receipt data is missing; bitmap proof cannot run.',
          },
        },
        categories: {
          castAsIntended: {
            title: 'Cast-as-Intended',
            description: 'Confirm that your choice matches the commitment.',
            items: {
              receiptPresent: 'Receipt fields present (voteId/commitment)',
              choiceRange: 'Choice range check (A-E)',
              randomFormat: 'Random format check (32-byte hex)',
              commitmentMatch: 'Commitment recomputation match (electionId + choice + random)',
            },
          },
          recordedAsCast: {
            title: 'Recorded-as-Cast',
            description: 'Verify bulletin board recording via public evidence.',
            items: {
              commitmentInBulletin: {
                label: 'Commitment present on bulletin',
                note: 'Covered by inclusion proof',
              },
              indexInRange: 'bulletinIndex range check',
              rootAtCastConsistent: {
                label: 'bulletinRootAtCast consistency',
                note: 'Covered by consistency proof',
              },
              inclusionProof: 'Inclusion proof verification (CT-style, RFC 6962-based)',
              consistencyProof: 'Consistency proof verification (split-view defense)',
              sthThirdParty: 'STH verification (third-party match)',
            },
          },
          countedAsRecorded: {
            title: 'Counted-as-Recorded',
            description: 'Validate tally inputs and ZK guarantees.',
            items: {
              inputSanity: 'zkVM input validity checks',
              uniqueIndices: 'Duplicate index exclusion',
              uniqueCommitments: 'Duplicate commitment exclusion',
              tallyConsistent: 'Tally guaranteed by ZK',
              missingIndicesZero: 'No exclusion signal in tally input',
              expectedVsTreeSize: 'totalExpected vs treeSize mismatch detection',
              electionManifestConsistent: 'Election manifest consistency (config hash)',
              closeStatementConsistent: 'Close statement consistency (STH digest)',
              myVoteIncluded: 'Your vote included (bitmap proof)',
              inputCommitmentMatch: 'Input commitment generation (index order)',
            },
          },
          starkVerification: {
            title: 'STARK Verification',
            description: 'Verify the zkVM proof.',
            items: {
              imageIdMatch: 'Image ID evidence consistency',
              receiptVerify: 'STARK proof verification (receipt.verify)',
            },
          },
        },
      },
      resultSummary: {
        ariaLabel: 'Verification summary',
        fullyVerifiedMain: 'Your vote was accurately reflected.',
        fullyVerifiedSub: 'No fraud was detected in this voting session.',
        inProgressMain: 'Verification is in progress.',
        inProgressSub: 'This page will update when it completes.',
        missingEvidenceMain: 'Verification could not be completed because some required data was missing.',
        verifiedWithLimitationsMain:
          'Verification succeeded with limitations: some optional cross-checks were not available.',
        userVoteExcludedMain: 'Fraud detected.',
        userVoteExcludedSub: 'Your vote was not included in the final tally.',
        userVoteMissingSub: 'Your vote appears to be missing from the final tally.',
        userVoteInvalidSub: 'Your vote was invalidated during tallying.',
        votesExcludedMain: 'Fraud detected.',
        votesExcludedSub:
          'Some votes were excluded from the tally. Your vote was counted, but the overall result is not fully verifiable.',
        votesMissingSub:
          'Some votes are missing from the tally. Your vote was counted, but the overall result is not fully verifiable.',
        votesInvalidSub:
          'Some votes were invalidated during tallying. Your vote was counted, but the overall result is not fully verifiable.',
        votesExcludedUnknownMain: 'Fraud detected.',
        votesExcludedUnknownSub:
          'Some votes were excluded from the tally, but we could not confirm whether your vote was included.',
        votesMissingUnknownUserSub:
          'Some votes are missing from the tally, and we could not confirm whether your vote was included.',
        votesInvalidUnknownUserSub:
          'Some votes were invalidated during tallying, and we could not confirm whether your vote was included.',
        recordedIntegrityFailedMain: 'We could not confirm that your vote was correctly recorded on the public board.',
        publishedTallyMismatchMain: 'Published results do not match the tally proven by the STARK proof.',
        publishedTallyMismatchSub:
          'No votes appear missing and your vote is included, but the reported counts differ from the ZK-proven counts.',
        countedIntegrityFailedMain: 'We could not verify the tally integrity.',
        countedIntegrityFailedSub: 'The published result may be incorrect.',
        castIntegrityFailedMain: 'We could not confirm that your receipt matches the vote you cast.',
        proofVerificationFailedMain: 'We could not verify the cryptographic proof for this tally.',
        proofVerificationFailedSub: 'The result cannot be trusted.',
      },
      download: {
        description: 'Contains proof data. Verify independently with a Rust environment.',
        cta: 'Download Bundle',
        loading: 'Downloading...',
        missingBundle: 'No verification bundle available for download',
        success: 'Bundle downloaded',
      },
      finalization: {
        messages: {
          waiting: 'Waiting for finalization job to start...',
          queued: 'Finalization queued at {{time}}.',
          running: 'Finalization in progress (started at {{time}}).',
          succeeded: 'Finalization completed at {{time}}.',
          failed: 'Finalization failed: {{message}} (code: {{code}}).',
          timeout: 'Finalization timed out before completing.',
          asyncDisabled: 'Async finalization unavailable',
          statusError: 'Status request failed ({{status}}).',
        },
        cancelErrorPrefix: 'Cancellation failed:',
        cancelled: 'Finalization cancelled. You can retry from the aggregate screen.',
      },
    },
  },
  errors: {
    generic: 'An error occurred',
    network: 'Network error',
    captchaFailed: 'Security check failed. Please try again.',
    sessionLimitExceeded: 'We are at capacity. Please try again later.',
  },
  security: {
    turnstileBypassed: 'Security check bypassed (development mode).',
    turnstileExpired: 'Security check expired. Please try again.',
  },
  actions: {
    reset: 'Start Over',
    resetConfirm: 'Start over from the beginning? All current progress will be lost.',
  },
  header: {
    languageSwitchToEnglish: 'Switch to English',
    languageSwitchToJapanese: 'Switch to Japanese',
  },
  footer: {
    terms: 'Terms of Use',
    privacy: 'Privacy Policy',
    spec: 'Spec',
    github: 'GitHub',
  },
  legal: {
    backToHome: 'Back to Home',
    sessionNotice: 'If you stay on this page for a long time, the session may expire.',
    closeTab: 'Close this tab',
    closeTabHint: 'If it does not close, please close this tab manually.',
  },
  knowledge: {
    title: 'What I Know',
    titleBot: 'What the Bot Knows',
    empty: 'No information yet',
    controls: {
      expand: 'Expand',
      collapse: 'Collapse',
    },
    items: {
      sessionId: 'Session ID',
      electionId: 'Election ID',
      electionConfigHash: 'Config Hash',
      logId: 'Log ID',
      bulletinRoot: 'Bulletin Root',
      treeSize: 'Tree Size',
      sthDigest: 'STH Digest',
      seenBitmapRoot: 'Seen Bitmap Root',
      includedBitmapRoot: 'Counted Bitmap Root',
      inputCommitment: 'Input Commitment',
      imageId: 'Claimed Image ID',
      missingSlots: 'Unpresented Slots',
      invalidPresentedSlots: 'Presented Slot Failures',
      rejectedRecords: 'Rejected Records',
      validVotes: 'Valid Votes',
      excludedSlots: 'Excluded Slots',
      totalExpected: 'Expected Votes',
      receiptPublication: 'Receipt Publication',
      proofBundleStatus: 'Proof Bundle',
      user: {
        choice: 'Choice',
        random: 'Random Value',
        commitment: 'Commitment',
        voteId: 'Vote ID',
        bulletinIndex: 'Bulletin Index',
        bulletinRootAtCast: 'Root at Cast',
        voteTimestamp: 'Vote Timestamp',
        voteReceipt: 'Vote Receipt',
        merklePath: 'Inclusion Proof',
      },
      botVotesStatus: 'Bot Votes Status',
      scenarioId: 'Tampering Scenario',
      tally: {
        counts: 'Tally Results',
        totalVotes: 'Total Votes',
        tamperedCount: 'Excluded Count',
      },
      verification: {
        steps: 'Verification Steps',
        reportSummary: 'Verification Report',
      },
      bot: {
        id: 'Bot ID',
        choice: 'Bot Choice',
        random: 'Bot Random',
        commitment: 'Bot Commitment',
        voteId: 'Bot Vote ID',
        bulletinIndex: 'Bot Index',
        bulletinRootAtCast: 'Bot Root at Cast',
        voteTimestamp: 'Bot Timestamp',
        merklePath: 'Bot Inclusion Proof',
        verification: {
          steps: 'Bot Verification',
        },
      },
    },
  },
  scenarios: {
    s0: 'No Tampering',
    s0Description: 'Process votes normally',
    s1: 'Exclude Your Vote',
    s1Description: 'Exclude your vote from the tally',
    s2: 'Tamper Claimed Tally for Your Vote',
    s2Description: 'Tamper only the claimed tally for the option you chose. Individual ballots are not identified.',
    s3: 'Exclude a Bot Vote',
    s3Description: 'Exclude one bot vote from the tally (simulation).',
    s4: 'Tamper Claimed Tally for a Bot Vote',
    s4Description: "Tamper only the claimed tally for one bot's vote. Individual ballots are not identified.",
    s5: 'Random Error Injection',
    s5Description: 'Randomly exclude or recount one vote',
  },
  infographic: {
    problemSolution: {
      heading: 'Voting Transparency, Proven by Cryptography',
      traditional: {
        title: 'Traditional Voting',
        description: 'Requires trust assumption',
      },
      starkBallot: {
        title: 'STARK Ballot Simulator',
        description: 'Verify it yourself',
      },
    },
    steps: {
      heading: 'The 4 Steps Ahead',
      vote: {
        label: 'Vote',
        brief: 'Select your choice',
      },
      aggregate: {
        label: 'Aggregate',
        brief: 'zkVM generates proof',
      },
      result: {
        label: 'Result',
        brief: 'View tally results',
      },
      verify: {
        label: 'Verify',
        brief: 'Confirm with crypto proof',
      },
    },
    guarantees: {
      heading: 'What Verification Proves',
      items: {
        noTampering: 'Your vote was not tampered with',
        correctlyRecorded: 'It was correctly recorded',
        correctlyTallied: 'All votes were tallied correctly',
      },
    },
    tamperDemo: {
      heading: 'Experience Tampering Scenarios',
      description:
        'Select a tampering scenario during aggregation and observe how fraud is detected through cryptographic verification (simulation).',
    },
  },
  verification: {
    tabs: {
      my: 'My Verification',
      bot: 'Verify as affected bot',
      botDisabledTooltip: 'Planned for a future update',
    },
    steps: {
      castAsIntended: 'Cast as Intended',
      recordedAsCast: 'Recorded as Cast',
      countedAsRecorded: 'Counted as Recorded',
      starkVerification: 'STARK Verification',
    },
    status: {
      pending: 'Pending',
      running: 'Verifying',
      success: 'Verified',
      failed: 'Failed',
      notRun: 'Not run',
    },
  },
} as const satisfies TranslationShape<typeof ja>;
