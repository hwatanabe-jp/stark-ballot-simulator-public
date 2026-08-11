export const ja = {
  common: {
    start: '開始',
    loading: '読み込み中...',
  },
  pages: {
    home: {
      welcome: 'STARK Ballot Simulatorへようこそ',
      description: 'STARK証明による検証可能投票の教育デモ',
    },
    vote: {
      title: '投票画面',
      overview:
        '以下の選択肢からお好みのオプションを選択してください。あなたの投票は暗号化され、投票プールに追加されます。',
      selectionTitle: '選択肢を選んでください',
      selectionLabel: '投票選択',
      optionLabel: '選択肢 {{option}}',
      submit: '投票する',
      submitting: '送信中...',
      errors: {
        sessionNotFound: 'セッションが見つかりません',
        sessionReplaced: '別タブで新しいセッションが開始されました。最初からやり直してください。',
      },
      botVoting: {
        title: '63体のボットが投票しています',
        processing: '処理中...',
      },
    },
    aggregate: {
      title: '集計画面',
      description: '集計オプションを選択してください。',
      execute: '集計を開始',
      executing: '集計中...',
      scenarios: {
        title: '改ざんシナリオ選択',
        cardTitle: '改ざんシナリオ',
        description: 'いずれか1つを選択して集計を開始します',
      },
      progress: {
        title: {
          processing: '集計処理中',
          completed: '集計完了',
        },
        description: {
          completed: '結果画面へ移動します',
          processing: '集計には5分ほど時間を要します',
        },
        phase: {
          waiting: 'キュー待機中',
          processing: '集計処理中',
          completed: '完了しました',
          error: 'エラー',
          timeout: 'タイムアウト',
        },
        queue: {
          waiting: '待機中',
          typicalDuration: '標準所要時間',
        },
        estimate: {
          approxSeconds: '約{{seconds}}秒',
          approxMinutes: '約{{minutes}}分',
        },
      },
      errors: {
        sessionNotFound: 'セッションが見つかりません',
        sessionReplaced: '別タブで新しいセッションが開始されました。最初からやり直してください。',
        scenarioRequired: '改ざんシナリオを選択してください',
        timeout: 'タイムアウトしました',
      },
    },
    result: {
      title: '集計結果',
      description: 'zkVM による集計が完了しました。',
      loading: '読み込み中...',
      errors: {
        sessionNotFound: 'セッションが見つかりません',
        sessionReplaced: '別タブで新しいセッションが開始されました。最初からやり直してください。',
        noResult: '集計結果がありません',
      },
      tally: {
        title: '投票結果',
        totalVotes: '合計 {{total}} 票',
      },
      noticeNotVerified: 'この結果はまだ検証されていません',
      startVerification: '結果の正当性を暗号学的に検証する',
    },
    verify: {
      title: '検証画面',
      subtitle: '検証結果を確認し、独立監査用の証明バンドルをダウンロードできます',
      loading: '検証結果を読み込み中...',
      sessionError: 'セッションが見つかりません。投票プロセスを完了してください。',
      sessionReplaced: '別タブで新しいセッションが開始されました。最初からやり直してください。',
      directAccess: '検証は集計結果ページから開始してください。',
      failed: '検証失敗',
      actions: {
        backToResult: '集計結果に戻る',
      },
      status: {
        partial: '検証は部分的に完了しました',
        timeout: 'STARK検証がタイムアウトしました',
      },
      stepsCard: {
        preparing: '検証準備中...',
        footnoteStarkLast: '※ STARK検証は最後に実行されます',
        footnoteClickable: '小項目をクリックすると知識パネルがハイライトされます。',
        evidence: {
          local: 'Local',
          public: 'Public',
          zk: 'ZK',
          demo: 'Demo',
        },
        status: {
          pending: '保留',
          running: '検証中',
          success: '合格',
          failed: '失敗',
        },
        errors: {
          generic: '検証中にエラーが発生しました。時間をおいて再度お試しください。',
        },
        notes: {
          myVoteIncluded: {
            excluded: '集計に除外レコードがあるため、個別の包含証明は利用できません。',
            notPresented: 'あなたの index は最終集計入力で prover に提示されていませんでした。',
            presentedButInvalid: 'あなたの index は prover に提示されましたが、検証に失敗して除外されました。',
            proofUnavailable: 'この環境ではビットマップ証明の素材が利用できません。',
            missingReceipt: '投票レシート情報が不足しているため、ビットマップ証明を実行できません。',
            leafEvidence:
              'この証明は32-byteのbitmap leafを認証し、UIはその leaf のうちあなたの bit だけを読み取ります。',
          },
        },
        categories: {
          castAsIntended: {
            title: 'Cast-as-Intended',
            description: '投票内容とコミットメントが一致していることを確認します。',
            items: {
              receiptPresent: '受領データ最低限チェック（voteId / commitment）',
              choiceRange: '選択肢レンジ検証（A–E）',
              randomFormat: '乱数フォーマット検証（32-byte hex）',
              commitmentMatch: 'Commitment再計算一致（electionId + choice + random）',
            },
          },
          recordedAsCast: {
            title: 'Recorded-as-Cast',
            description: '掲示板に正しく記録されたことを公開証拠で確認します。',
            items: {
              commitmentInBulletin: {
                label: '掲示板に commitment が存在',
                note: 'Inclusion proof に統合',
              },
              indexInRange: 'bulletinIndex 範囲チェック',
              rootAtCastConsistent: {
                label: 'bulletinRootAtCast の整合',
                note: 'Consistency proof に統合',
              },
              inclusionProof: 'Inclusion proof 検証（CTスタイル / RFC 6962ベース）',
              consistencyProof: 'Consistency proof 検証（split-view 対策）',
              sthThirdParty: 'STH 検証（第三者一致）',
            },
          },
          countedAsRecorded: {
            title: 'Counted-as-Recorded',
            description: '集計入力とZK保証を突き合わせて正当性を確認します。',
            items: {
              inputSanity: 'zkVM入力の妥当性（treeSize>0 / votes<=treeSize / root≠0）',
              uniqueIndices: '重複 index 排除',
              uniqueCommitments: '重複 commitment 排除',
              tallyConsistent: '集計結果が zkVM journal と一致',
              missingIndicesZero: '集計証明の出力に除外 slot なし',
              expectedVsTreeSize: 'totalExpected vs treeSize 不一致検知',
              electionManifestConsistent: 'Election manifest 整合（設定ハッシュ）',
              closeStatementConsistent: 'Close statement 整合（STH digest）',
              myVoteIncluded: '選択された投票 bit の認証（bitmap leaf proof）',
              inputCommitmentMatch: 'inputCommitment 生成（index順）',
            },
          },
          starkVerification: {
            title: 'STARK Verification',
            description: 'zkVMの証明を検証し、計算の正当性を確認します。',
            items: {
              imageIdMatch: 'Image ID 証拠整合',
              receiptVerify: 'STARK receipt 検証',
            },
          },
        },
      },
      resultSummary: {
        ariaLabel: '検証結果サマリー',
        fullyVerifiedMain: 'あなたの投票は正確に反映されました。',
        fullyVerifiedSub: 'このセッションでは、必須の整合性・包含・ImageID・本番 proof 検証に合格しました。',
        demoOnlyMain: 'デモ検証が完了しました。',
        demoOnlySub:
          '必須のデモ検証には合格しましたが、この実行は本番STARK proofではなく開発モードreceiptを使用しています。',
        inProgressMain: '検証を実行中です。',
        inProgressSub: '完了するとこのページに結果が表示されます。',
        missingEvidenceMain: '必要なデータが不足しているため、検証を完了できませんでした。',
        verifiedWithLimitationsMain: '一部の追加検証が利用できないため、制約付きで検証が完了しました。',
        userVoteExcludedMain: '検証未成立です。',
        userVoteExcludedSub: 'あなたの投票は最終集計に含まれていません。',
        userVoteMissingSub: 'あなたの投票は最終集計から欠落している可能性があります。',
        userVoteInvalidSub: 'あなたの投票は集計時に無効化されました。',
        votesExcludedMain: '検証未成立です。',
        votesExcludedSub:
          'いくつかの票が集計から除外されています。あなたの投票は集計に含まれていますが、全体結果は完全には検証できません。',
        votesMissingSub:
          'いくつかの票が集計から欠落しています。あなたの投票は集計に含まれていますが、全体結果は完全には検証できません。',
        votesInvalidSub:
          'いくつかの票が集計時に無効化されています。あなたの投票は集計に含まれていますが、全体結果は完全には検証できません。',
        votesExcludedUnknownMain: '検証未成立です。',
        votesExcludedUnknownSub:
          'いくつかの票が集計から除外されていますが、あなたの投票が含まれたか確認できませんでした。',
        votesMissingUnknownUserSub:
          'いくつかの票が集計から欠落していますが、あなたの投票が含まれたか確認できませんでした。',
        votesInvalidUnknownUserSub:
          'いくつかの票が集計時に無効化されていますが、あなたの投票が含まれたか確認できませんでした。',
        recordedIntegrityFailedMain: 'あなたの投票が公開記録に正しく記録されたことを確認できませんでした。',
        publishedTallyMismatchMain: '公開された結果がSTARK証明で示された集計と一致しません。',
        publishedTallyMismatchSub:
          '欠落票は見当たらずあなたの投票も含まれていますが、公開された得票数がZK証明された得票数と一致しません。',
        countedIntegrityFailedMain: '集計の整合性を検証できませんでした。',
        countedIntegrityFailedSub: '公開結果が正しくない可能性があります。',
        castIntegrityFailedMain: '投票内容と受領証の一致を確認できませんでした。',
        proofVerificationFailedMain: 'この集計の証明を検証できませんでした。',
        proofVerificationFailedSub: '結果を信頼できません。',
      },
      download: {
        description: '証明データを含むバンドルです。Rust環境で独自に検証できます。',
        cta: 'バンドルをダウンロード',
        loading: 'ダウンロード中...',
        missingBundle: 'ダウンロード可能な検証バンドルがありません',
        success: 'バンドルをダウンロードしました',
      },
    },
  },
  errors: {
    generic: 'エラーが発生しました',
    network: 'ネットワークエラー',
    captchaFailed: 'セキュリティチェックに失敗しました。再度お試しください。',
    sessionLimitExceeded: '現在混雑しています。しばらくしてからお試しください。',
  },
  security: {
    turnstileBypassed: 'セキュリティチェックをスキップしています（開発モード）',
    turnstileExpired: 'セキュリティチェックの有効期限が切れました。再実行してください。',
  },
  actions: {
    reset: 'やり直す',
    resetConfirm: '最初からやり直しますか？現在の進捗はすべて失われます。',
  },
  header: {
    languageSwitchToEnglish: '英語に切り替え',
    languageSwitchToJapanese: '日本語に切り替え',
  },
  footer: {
    terms: '利用規約',
    privacy: 'プライバシーポリシー',
    spec: '技術仕様',
    github: 'GitHub',
  },
  legal: {
    backToHome: 'トップに戻る',
    sessionNotice: '長時間閲覧するとセッションが失効する可能性があります。',
    closeTab: 'このタブを閉じる',
    closeTabHint: '閉じられない場合はこのタブを手動で閉じてください。',
  },
  knowledge: {
    title: '私が知っている情報',
    titleBot: 'ボットが知っている情報',
    empty: 'まだ情報がありません',
    controls: {
      expand: '展開',
      collapse: '縮小',
    },
    items: {
      sessionId: 'セッションID',
      electionId: '選挙ID',
      electionConfigHash: '設定ハッシュ',
      logId: 'ログID',
      bulletinRoot: '掲示板ルート',
      treeSize: 'ツリーサイズ',
      sthDigest: 'STHダイジェスト',
      seenBitmapRoot: '提示ビットマップルート',
      includedBitmapRoot: '計上ビットマップルート',
      inputCommitment: '入力コミット',
      imageId: '申告 Image ID',
      missingSlots: '未提示スロット数',
      invalidPresentedSlots: '提示された未計上スロット数',
      rejectedRecords: '拒否レコード数',
      validVotes: '有効票数',
      excludedSlots: '除外スロット数',
      totalExpected: '期待票数',
      receiptPublication: 'レシート公開',
      proofBundleStatus: '証明バンドル',
      user: {
        choice: '選択',
        random: 'ランダム値',
        commitment: 'コミットメント',
        voteId: '投票ID',
        bulletinIndex: '掲示板番号',
        bulletinRootAtCast: '投票時ルート',
        castAtMs: '投票日時',
        voteReceipt: '投票レシート',
        merklePath: '包含証明',
      },
      botVotesStatus: 'ボット投票状況',
      scenarioId: '改ざんシナリオ',
      tally: {
        counts: '集計結果',
        totalVotes: '総投票数',
        tamperedCount: '除外数',
      },
      verification: {
        steps: '検証ステップ',
        reportSummary: '検証レポート',
      },
      bot: {
        id: 'ボットID',
        choice: 'ボット選択',
        random: 'ボットランダム',
        commitment: 'ボットコミット',
        voteId: 'ボット投票ID',
        bulletinIndex: 'ボット番号',
        bulletinRootAtCast: 'ボット投票時ルート',
        voteTimestamp: 'ボット投票日時',
        merklePath: 'ボット包含証明',
        verification: {
          steps: 'ボット検証',
        },
      },
    },
  },
  scenarios: {
    s0: '改ざんしない',
    s0Description: '正常な集計処理を行います',
    s1: 'あなたの投票を除外する',
    s1Description: 'あなたの投票を集計から除外します',
    s2: 'あなたの投票に関する発表結果を改ざんする',
    s2Description: 'あなたが選んだ選択肢の集計結果のみを改ざんします。個票は特定しません',
    s3: '1体のボット投票を除外する',
    s3Description: '1体のボット投票を集計から除外します（シミュレーション）',
    s4: '1体のボットの投票に関する発表結果を改ざんする',
    s4Description: '1体のボットが選んだ選択肢の集計結果のみを改ざんします。個票は特定しません',
    s5: 'ランダムエラー注入',
    s5Description: 'ランダムに1票を除外または再集計します',
  },
  infographic: {
    problemSolution: {
      heading: '投票の透明性を、暗号で証明する',
      traditional: {
        title: '従来の投票',
        description: 'システムに信頼仮定',
      },
      starkBallot: {
        title: 'STARK Ballot Simulator',
        description: '自分で検証できる',
      },
    },
    steps: {
      heading: 'これから体験する4ステップ',
      vote: {
        label: '投票',
        brief: '選択肢を選ぶ',
      },
      aggregate: {
        label: '集計',
        brief: 'zkVMが証明生成',
      },
      result: {
        label: '結果',
        brief: '集計結果を確認',
      },
      verify: {
        label: '検証',
        brief: '暗号証明で確認',
      },
    },
    guarantees: {
      heading: '検証で確かめられること',
      items: {
        noTampering: '投票が改ざんされていないか',
        correctlyRecorded: '票が結果に正しく含まれたか',
        correctlyTallied: '全票が正しく集計されたか',
      },
    },
    tamperDemo: {
      heading: '改ざんシナリオを体験',
      description: '集計時に改ざんシナリオを選択し、不正が暗号検証で検知される過程をシミュレーションで観察できます。',
    },
  },
  verification: {
    tabs: {
      my: '私の検証',
      bot: '被害者ボットになりきって検証',
      botDisabledTooltip: '将来実装予定',
    },
  },
} as const;
