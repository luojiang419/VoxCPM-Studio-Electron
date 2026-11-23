"""SQLite一致性备份和独立恢复验证；不输出账号、密码哈希或会话。"""
import argparse
from pathlib import Path
import sqlite3


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['backup','verify'])
    parser.add_argument('database',type=Path)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    source=args.database.resolve()
    if not source.is_file():
        raise ValueError('数据库文件不存在')
    with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as db:
        if args.operation=='backup':
            if not args.output or args.output.exists():
                raise ValueError('请指定尚未存在的备份文件')
            args.output.parent.mkdir(parents=True,exist_ok=True)
            with sqlite3.connect(args.output) as target:
                db.backup(target)
            args.output.chmod(0o600)
        else:
            with sqlite3.connect(':memory:') as restored:
                db.backup(restored)
                assert restored.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
                assert restored.execute("SELECT COUNT(*) FROM identities WHERE role='admin'").fetchone()[0]>=1
    print('一致性备份完成' if args.operation=='backup' else '独立恢复与完整性检查通过')


if __name__=='__main__':
    main()
