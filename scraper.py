#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Price Scraper using requests and re (regex) in Python.
Designed to be run on a server or via GitHub Actions (serverless).
"""

import os
import re
import json
import random
import datetime
import requests

# Paths to data files
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VARIABLES_PATH = os.path.join(BASE_DIR, "src", "data", "variables.json")
PRICES_PATH = os.path.join(BASE_DIR, "src", "data", "prices.json")
ALERTS_PATH = os.path.join(BASE_DIR, "src", "data", "alerts.json")

# Simple User-Agent to avoid blocks
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5"
}

def load_json(filepath, default):
    if not os.path.exists(filepath):
        # Create directory if not exists
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(default, f, indent=2, ensure_ascii=False)
        return default
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading {filepath}: {e}")
        return default

def save_json(filepath, data):
    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving {filepath}: {e}")

def clean_and_parse_value(raw_str):
    """
    Cleans raw regex output string and converts it to float/int.
    Handles Persian numbers, commas, spaces.
    """
    if not raw_str:
        return 0.0
    
    # Replace Persian/Arabic numbers with English
    persian_chars = "۰۱۲۳۴۵۶۷۸۹"
    arabic_chars = "٠١٢٣٤٥٦٧٨٩"
    for i in range(10):
        raw_str = raw_str.replace(persian_chars[i], str(i))
        raw_str = raw_str.replace(arabic_chars[i], str(i))
    
    # Remove commas, spaces, currency symbols
    raw_str = re.sub(r"[^\d.]", "", raw_str)
    
    try:
        if "." in raw_str:
            return float(raw_str)
        return int(raw_str) if raw_str else 0.0
    except ValueError:
        return 0.0

def scrape_target(variable):
    print(f"Scraping '{variable['name']}' from: {variable['url']}")
    try:
        # Fetch web page
        response = requests.get(variable["url"], headers=HEADERS, timeout=15)
        if response.status_code != 200:
            raise Exception(f"HTTP Error {response.status_code}")
            
        html = response.text
        
        # Regex search
        pattern = variable["regex"]
        match = re.search(pattern, html)
        
        if not match:
            # Try a looser match if it's the preloaded tgju profile
            if "tgju.org" in variable["url"]:
                # Fallback for tgju structure
                fallback_match = re.search(r'class="value">([^<]+)</span>', html)
                if fallback_match:
                    match = fallback_match
            
        if not match:
            raise Exception(f"Pattern '{pattern}' not found in HTML")
            
        raw_val = match.group(1).strip()
        parsed_val = clean_and_parse_value(raw_val)
        
        print(f"Successfully extracted: '{raw_val}' -> {parsed_val}")
        return {
            "success": True,
            "raw": raw_val,
            "value": parsed_val,
            "error": None
        }
    except Exception as e:
        print(f"Failed to scrape {variable['name']}: {e}")
        return {
            "success": False,
            "raw": None,
            "value": 0,
            "error": str(e)
        }

def main():
    print(f"Starting Scraper at {datetime.datetime.now().isoformat()}")
    
    variables = load_json(VARIABLES_PATH, [])
    prices = load_json(PRICES_PATH, [])
    alerts = load_json(ALERTS_PATH, [])
    
    timestamp = datetime.datetime.now().isoformat() + "Z"
    updated_any = False
    
    for var in variables:
        if not var.get("active", True):
            print(f"Skipping '{var['name']}' (inactive)")
            continue
            
        res = scrape_target(var)
        
        # Update variable state
        var["lastScraped"] = timestamp
        if res["success"]:
            var["lastStatus"] = "success"
            var["lastError"] = None
            
            # Record price
            new_price = res["value"]
            
            # Find last price
            var_prices = [p for p in prices if p["variableId"] == var["id"]]
            old_price = var_prices[-1]["value"] if var_prices else None
            
            # Append new record if price changed or no history exists
            # In a real environment, we may append every run or only when changed
            if old_price is None or old_price != new_price:
                price_id = f"p_{int(datetime.datetime.now().timestamp())}_{random.randint(100, 999)}"
                prices.append({
                    "id": price_id,
                    "variableId": var["id"],
                    "value": new_price,
                    "timestamp": timestamp,
                    "rawText": res["raw"]
                })
                
                # Check for significant change (alert trigger)
                if old_price is not None and old_price > 0:
                    change_pct = ((new_price - old_price) / old_price) * 100
                    # Alert on change of any amount for logs, can be customized
                    alert_id = f"a_{int(datetime.datetime.now().timestamp())}_{random.randint(100, 999)}"
                    alerts.append({
                        "id": alert_id,
                        "variableId": var["id"],
                        "variableName": var["name"],
                        "oldValue": old_price,
                        "newValue": new_price,
                        "changePercent": round(change_pct, 2),
                        "timestamp": timestamp
                    })
                    print(f"Alert! Price changed for {var['name']}: {old_price} -> {new_price} ({change_pct:.2f}%)")
                    
            updated_any = True
        else:
            var["lastStatus"] = "failed"
            var["lastError"] = res["error"]
            updated_any = True
            
    if updated_any:
        save_json(VARIABLES_PATH, variables)
        save_json(PRICES_PATH, prices)
        save_json(ALERTS_PATH, alerts)
        print("All data updated and saved successfully.")
    else:
        print("No active targets or updates.")

if __name__ == "__main__":
    main()
