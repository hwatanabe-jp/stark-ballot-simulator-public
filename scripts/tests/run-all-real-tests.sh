#!/bin/bash
set -e

LOG_DIR="${LOG_DIR:-.tmp/test-logs/$(date +%Y-%m-%d)}"
SUMMARY="$LOG_DIR/summary.log"

# ログディレクトリ作成
mkdir -p "$LOG_DIR"

echo "=== STARK Ballot Simulator Real zkVM Test Run Started at $(date) ===" | tee $SUMMARY
echo "Total patterns: 30 (5 choices × 6 scenarios)" | tee -a $SUMMARY
echo "Total CLI invocations: 5 (each runs S0-S5)" | tee -a $SUMMARY
echo "Estimated time: ~210 minutes (3.5 hours with 1-min intervals)" | tee -a $SUMMARY
echo "" >> $SUMMARY

COUNTER=0
for CHOICE in A B C D E; do
  COUNTER=$((COUNTER + 1))
  LOG_FILE="$LOG_DIR/choice-${CHOICE}_all-scenarios.log"

  echo "[$(date +"%H:%M:%S")] [$COUNTER/5] Starting: User=$CHOICE, Scenarios=S0-S5" | tee -a $SUMMARY

  if pnpm test:cli:real-prod:all -- --user-choice $CHOICE --skip-build > "$LOG_FILE" 2>&1; then
    echo "[$(date +"%H:%M:%S")] [$COUNTER/5] ✅ PASSED: User=$CHOICE, Scenarios=S0-S5" | tee -a $SUMMARY
  else
    EXIT_CODE=$?
    echo "[$(date +"%H:%M:%S")] [$COUNTER/5] ❌ FAILED: User=$CHOICE, Scenarios=S0-S5 (exit code: $EXIT_CODE)" | tee -a $SUMMARY
  fi

  # 最後のテスト以外は1分待機
  if [ $COUNTER -lt 5 ]; then
    echo "[$(date +"%H:%M:%S")] Waiting 60 seconds before next test..." | tee -a $SUMMARY
    sleep 60
  fi

  echo "" >> $SUMMARY
done

echo "=== STARK Ballot Simulator Real zkVM Test Run Completed at $(date) ===" | tee -a $SUMMARY
echo "See individual logs in $LOG_DIR/" | tee -a $SUMMARY

# 最終集計
PASSED=$(grep -c "✅ PASSED" $SUMMARY || echo 0)
FAILED=$(grep -c "❌ FAILED" $SUMMARY || echo 0)
echo "" | tee -a $SUMMARY
echo "Final Results: $PASSED passed, $FAILED failed" | tee -a $SUMMARY
