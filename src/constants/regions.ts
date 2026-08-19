/**
 * 省 → 市级联数据（精简版，覆盖各省会与主要城市）。
 *
 * 用于「编辑资料 - 地区」的二级联动选择器。数据只保留常用城市，
 * 满足大多数用户的归属地选择；如需完整行政区划，可在此扩展。
 */

export interface RegionProvince {
  name: string
  cities: string[]
}

export const REGION_DATA: RegionProvince[] = [
  { name: '北京市', cities: ['北京市'] },
  { name: '上海市', cities: ['上海市'] },
  { name: '天津市', cities: ['天津市'] },
  { name: '重庆市', cities: ['重庆市'] },
  { name: '广东省', cities: ['广州市', '深圳市', '东莞市', '佛山市', '珠海市', '中山市', '惠州市'] },
  { name: '江苏省', cities: ['南京市', '苏州市', '无锡市', '常州市', '徐州市', '南通市'] },
  { name: '浙江省', cities: ['杭州市', '宁波市', '温州市', '嘉兴市', '金华市', '绍兴市'] },
  { name: '山东省', cities: ['济南市', '青岛市', '烟台市', '潍坊市', '临沂市'] },
  { name: '四川省', cities: ['成都市', '绵阳市', '德阳市', '宜宾市', '南充市'] },
  { name: '湖北省', cities: ['武汉市', '宜昌市', '襄阳市', '荆州市'] },
  { name: '湖南省', cities: ['长沙市', '株洲市', '岳阳市', '衡阳市'] },
  { name: '河南省', cities: ['郑州市', '洛阳市', '南阳市', '新乡市'] },
  { name: '河北省', cities: ['石家庄市', '唐山市', '保定市', '邯郸市'] },
  { name: '福建省', cities: ['福州市', '厦门市', '泉州市', '漳州市'] },
  { name: '陕西省', cities: ['西安市', '咸阳市', '宝鸡市', '渭南市'] },
  { name: '辽宁省', cities: ['沈阳市', '大连市', '鞍山市', '锦州市'] },
  { name: '安徽省', cities: ['合肥市', '芜湖市', '蚌埠市', '阜阳市'] },
  { name: '江西省', cities: ['南昌市', '赣州市', '九江市', '上饶市'] },
  { name: '云南省', cities: ['昆明市', '大理市', '丽江市', '曲靖市'] },
  { name: '广西壮族自治区', cities: ['南宁市', '桂林市', '柳州市', '北海市'] },
  { name: '山西省', cities: ['太原市', '大同市', '临汾市', '运城市'] },
  { name: '黑龙江省', cities: ['哈尔滨市', '大庆市', '齐齐哈尔市'] },
  { name: '吉林省', cities: ['长春市', '吉林市', '延吉市'] },
  { name: '贵州省', cities: ['贵阳市', '遵义市', '六盘水市'] },
  { name: '甘肃省', cities: ['兰州市', '天水市', '酒泉市'] },
  { name: '海南省', cities: ['海口市', '三亚市', '儋州市'] },
  { name: '内蒙古自治区', cities: ['呼和浩特市', '包头市', '鄂尔多斯市'] },
  { name: '新疆维吾尔自治区', cities: ['乌鲁木齐市', '克拉玛依市', '喀什市'] },
  { name: '宁夏回族自治区', cities: ['银川市', '石嘴山市'] },
  { name: '青海省', cities: ['西宁市', '格尔木市'] },
  { name: '西藏自治区', cities: ['拉萨市', '日喀则市'] },
  { name: '香港特别行政区', cities: ['香港岛', '九龙', '新界'] },
  { name: '澳门特别行政区', cities: ['澳门半岛', '氹仔', '路环'] },
  { name: '台湾省', cities: ['台北市', '高雄市', '台中市'] },
]

/** 解析「省份 城市」拼接串为 [province, city] */
export function parseRegion(region?: string | null): [string, string] {
  if (!region) return ['', '']
  const parts = region.split(' ')
  if (parts.length >= 2) return [parts[0], parts.slice(1).join(' ')]
  return [parts[0], '']
}
