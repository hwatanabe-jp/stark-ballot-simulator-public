#!/bin/bash
# Generate test JSON files for each tamper scenario
set -e

echo "=== Generating Test Data for Tamper Scenarios ==="
echo "Time: $(date)"
echo ""

# Create test data directory if it doesn't exist
mkdir -p zkvm/test-data

# Python script to generate test data
cat << 'EOF_PYTHON' > /tmp/generate_test_data.py
import json
import hashlib

# Constants
BOT_COUNT = 63
VOTE_CHOICES = 5  # A-E (0-4)

def generate_deterministic_random(seed_str):
    """Generate deterministic 32-byte random value from seed string"""
    h = hashlib.sha256(seed_str.encode()).digest()
    return list(h)

def create_base_test_data():
    """Create base test data with 1 user + 63 bot votes"""
    # User vote (choice A)
    user_vote = {
        "choice": 0,  # A
        "valid": True,
        "random": generate_deterministic_random("user-vote-seed")
    }
    
    user_commitment = {
        "commitment": generate_deterministic_random("user-commitment-seed"),
        "leaf_index": 0
    }
    
    # Bot votes - distribute evenly among choices
    bot_votes = []
    bot_commitments = []
    
    for i in range(BOT_COUNT):
        choice = i % VOTE_CHOICES
        bot_votes.append({
            "choice": choice,
            "valid": True,
            "random": generate_deterministic_random(f"bot-{i}-random")
        })
        
        bot_commitments.append({
            "commitment": generate_deterministic_random(f"bot-{i}-commitment"),
            "leaf_index": i + 1
        })
    
    return {
        "user_vote": user_vote,
        "user_commitment": user_commitment,
        "bot_votes": bot_votes,
        "bot_commitments": bot_commitments,
        "expected_merkle_root": [0] * 32,  # Will be computed by zkVM
        "total_vote_count": 64  # 1 user + 63 bots
    }

def create_scenario_data(base_data, scenario_name):
    """Create test data for specific scenario"""
    data = json.loads(json.dumps(base_data))  # Deep copy
    
    # Initialize scenario flags
    scenario = {
        "ignore_user_vote": False,
        "recount_user_as_other": False,
        "recount_user_to": 0,
        "ignore_bot_vote": [False] * BOT_COUNT,
        "recount_bot_as_other": [False] * BOT_COUNT,
        "recount_bot_to": [0] * BOT_COUNT,
        "random_error": False,
        "random_seed": 12345
    }
    
    # Apply scenario-specific settings
    if scenario_name == "s0-notamper":
        # No tampering - baseline
        pass
    
    elif scenario_name == "s1-ignore-user":
        # S1: Ignore user vote
        scenario["ignore_user_vote"] = True
    
    elif scenario_name == "s2-recount-user":
        # S2: Recount user vote to E (4)
        scenario["recount_user_as_other"] = True
        scenario["recount_user_to"] = 4  # E
    
    elif scenario_name == "s3-ignore-bot":
        # S3: Ignore one random bot vote
        # Using seed + 3 to match executor.ts logic
        random_bot_index = (scenario["random_seed"] + 3) % BOT_COUNT
        scenario["ignore_bot_vote"][random_bot_index] = True
        print(f"S3: Ignoring bot at index {random_bot_index}")
    
    elif scenario_name == "s4-recount-bot":
        # S4: Recount one random bot vote to E
        # Using seed + 4 to match executor.ts logic
        random_bot_index = (scenario["random_seed"] + 4) % BOT_COUNT
        scenario["recount_bot_as_other"][random_bot_index] = True
        scenario["recount_bot_to"][random_bot_index] = 4  # E
        print(f"S4: Recounting bot at index {random_bot_index} to E")
    
    elif scenario_name == "s5-random":
        # S5: Random error injection
        scenario["random_error"] = True
    
    data["scenario"] = scenario
    return data

# Generate test data for each scenario
scenarios = [
    "s0-notamper",
    "s1-ignore-user",
    "s2-recount-user",
    "s3-ignore-bot",
    "s4-recount-bot",
    "s5-random"
]

base_data = create_base_test_data()

for scenario in scenarios:
    data = create_scenario_data(base_data, scenario)
    filename = f"zkvm/test-data/test-{scenario}.json"
    
    with open(filename, 'w') as f:
        json.dump(data, f, indent=2)
    
    print(f"Generated: {filename}")

print("\nTest data generation complete!")
print("\nExpected tamper counts:")
print("- S0 (no tamper): 0")
print("- S1 (ignore user): 1")
print("- S2 (recount user): 1")
print("- S3 (ignore bot): 1")
print("- S4 (recount bot): 1")
print("- S5 (random): varies (5% of votes)")
EOF_PYTHON

# Run the Python script
python3 /tmp/generate_test_data.py

# Clean up
rm /tmp/generate_test_data.py

echo ""
echo "Test data files created in zkvm/test-data/"
ls -la zkvm/test-data/test-s*.json