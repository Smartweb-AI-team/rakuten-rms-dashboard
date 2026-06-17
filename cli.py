"""
main.py — CLI
  python main.py collect                       # 일별 수집(D-14~D-1 재수집)
  python main.py ask "어제 RPP 액세스 왜 줄었어?"   # AI챗 질의
환경변수: ANTHROPIC_API_KEY, RAKUTEN_STORAGE_STATE, SHOP_ID
"""
import os
import sys

from db import DB


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    shop_id = os.environ.get("SHOP_ID", "275374")
    db = DB()

    if cmd == "collect":
        from rakuten_client import RakutenAdClient
        from collector import collect_daily
        client = RakutenAdClient.from_storage_state(
            os.environ.get("RAKUTEN_STORAGE_STATE", "storage_state.json"))
        print("수집 결과:", collect_daily(client, db, shop_id))

    elif cmd == "ask":
        from ai_chat import ask
        question = " ".join(sys.argv[2:]) or "어제 RPP 데이터 보여줘"
        print(ask(question, shop_id=shop_id, db=db))

    else:
        print(__doc__)


if __name__ == "__main__":
    main()
