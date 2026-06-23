import openpyxl
from datetime import datetime, timedelta
import random

# 北京朝阳区/通州区示例坐标
base_locations = [
    {"location_name": "国贸中心", "address": "北京市朝阳区建国门外大街1号", "lat": 39.9078, "lng": 116.4475, "customer_name": "ABC科技"},
    {"location_name": "万达广场", "address": "北京市朝阳区建国路88号", "lat": 39.9142, "lng": 116.4668, "customer_name": "XYZ贸易"},
    {"location_name": "三里屯太古里", "address": "北京市朝阳区三里屯路19号", "lat": 39.9353, "lng": 116.4545, "customer_name": "时尚零售"},
    {"location_name": "望京SOHO", "address": "北京市朝阳区望京街9号", "lat": 39.9990, "lng": 116.4810, "customer_name": "未来网络"},
    {"location_name": "通州运河商务区", "address": "北京市通州区新华北路", "lat": 39.9095, "lng": 116.6600, "customer_name": "运河物流"},
    {"location_name": "北京经开区", "address": "北京市大兴区亦庄", "lat": 39.7900, "lng": 116.5200, "customer_name": "智能制造"},
]

users = [
    {"user_name": "张伟", "department": "华东销售部"},
    {"user_name": "李娜", "department": "华北销售部"},
]

def jitter(value, delta):
    return round(value + random.uniform(-delta, delta), 6)

def generate_rows():
    rows = []
    start_date = datetime(2024, 6, 20, 8, 0, 0)
    for idx, user in enumerate(users):
        current = start_date
        for i in range(8):
            loc = base_locations[i % len(base_locations)]
            # 每次移动 30-90 分钟
            current += timedelta(minutes=random.randint(30, 90))
            rows.append({
                "user_name": user["user_name"],
                "time": current.strftime("%Y-%m-%d %H:%M:%S"),
                "location_name": loc["location_name"],
                "address": loc["address"],
                "lat": jitter(loc["lat"], 0.0015),
                "lng": jitter(loc["lng"], 0.0015),
                "customer_name": loc["customer_name"],
            })
            # 部分停留产生重复位置
            if random.random() > 0.6:
                current += timedelta(minutes=random.randint(12, 25))
                rows.append({
                    "user_name": user["user_name"],
                    "time": current.strftime("%Y-%m-%d %H:%M:%S"),
                    "location_name": loc["location_name"],
                    "address": loc["address"],
                    "lat": jitter(loc["lat"], 0.0005),
                    "lng": jitter(loc["lng"], 0.0005),
                    "customer_name": loc["customer_name"],
                })

        # 为第二个用户制造异常：长停留 + 长空闲
        if idx == 1:
            long_stop_loc = base_locations[-1]
            current += timedelta(minutes=200)
            rows.append({
                "user_name": user["user_name"],
                "time": current.strftime("%Y-%m-%d %H:%M:%S"),
                "location_name": long_stop_loc["location_name"],
                "address": long_stop_loc["address"],
                "lat": jitter(long_stop_loc["lat"], 0.0005),
                "lng": jitter(long_stop_loc["lng"], 0.0005),
                "customer_name": long_stop_loc["customer_name"],
            })
            current += timedelta(minutes=130)
            rows.append({
                "user_name": user["user_name"],
                "time": current.strftime("%Y-%m-%d %H:%M:%S"),
                "location_name": long_stop_loc["location_name"],
                "address": long_stop_loc["address"],
                "lat": jitter(long_stop_loc["lat"], 0.0005),
                "lng": jitter(long_stop_loc["lng"], 0.0005),
                "customer_name": long_stop_loc["customer_name"],
            })
    return rows

rows = generate_rows()

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "visits"
headers = ["user_name", "time", "location_name", "address", "lat", "lng", "customer_name"]
ws.append(headers)
for r in rows:
    ws.append([r[h] for h in headers])

wb.save("data/mock-visits.xlsx")
print(f"Generated {len(rows)} mock visit rows -> data/mock-visits.xlsx")
